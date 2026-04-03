import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendQuestEvent,
	createQuest,
	loadActiveQuest,
	saveQuest,
} from "../src/state-core.js";
import type { QuestState, WorkerRunRecord } from "../src/types.js";

interface ScenarioResult {
	id: string;
	title: string;
	passed: boolean;
	summary: string;
	artifacts?: Record<string, unknown>;
}

interface ScenarioContext {
	rootDir: string;
	agentDir: string;
	repoDir: string;
}

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(extensionDir, "evals", "fixtures");
const liveAgentDir = join(process.env.HOME ?? "", ".pi", "agent");
const modelArgs = ["--model", "openai-codex/gpt-5.4-mini", "--thinking", "low"];
const scenarioModelChoice = {
	provider: "openai-codex",
	model: "gpt-5.4-mini",
	thinkingLevel: "low",
} as const;
const agentSettings = {
	defaultProvider: "openai-codex",
	defaultModel: "gpt-5.4",
	defaultThinkingLevel: "high",
	enabledModels: [
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.4-mini",
		"opencode-go/glm-5",
		"opencode-go/kimi-k2.5",
		"opencode-go/minimax-m2.7",
	],
	retry: {
		enabled: false,
		maxRetries: 0,
	},
	quietStartup: true,
	enableSkillCommands: true,
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function commandRoleRun(summary: string): WorkerRunRecord {
	return {
		id: `run-${Date.now()}`,
		role: "worker",
		startedAt: Date.now() - 500,
		endedAt: Date.now(),
		provider: "openai-codex",
		model: "gpt-5.4-mini",
		thinkingLevel: "low",
		exitCode: 0,
		ok: true,
		summary,
		phase: "completed",
		events: [],
	};
}

function parseJsonLines(output: string): any[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

async function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return await new Promise((resolvePromise) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let finished = false;
		const timeout = setTimeout(() => {
			if (finished) return;
			stderr += `\nTimed out after ${options.timeoutMs ?? 120000}ms`;
			proc.kill("SIGTERM");
		}, options.timeoutMs ?? 120000);
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			finished = true;
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
		});
		proc.on("error", (error) => {
			finished = true;
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr: `${stderr}\n${error}`, exitCode: 1 });
		});
	});
}

async function runPi(context: ScenarioContext, prompt: string, extraArgs: string[] = []) {
	return await runCommand(
		"pi",
		["--no-session", "--mode", "json", ...modelArgs, ...extraArgs, "-p", prompt],
		{
			cwd: context.repoDir,
			env: {
				PI_CODING_AGENT_DIR: context.agentDir,
			},
		},
	);
}

async function withScenarioSandbox<T>(fixtureName: string, fn: (context: ScenarioContext) => Promise<T>): Promise<T> {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-quests-scenario-"));
	const agentDir = join(rootDir, "agent");
	const repoDir = join(rootDir, "repo");
	const extensionLinkDir = join(agentDir, "extensions");

	await mkdir(extensionLinkDir, { recursive: true });
	await cp(join(fixturesDir, fixtureName), repoDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(agentSettings, null, 2)}\n`, "utf-8");
	if (existsSync(join(liveAgentDir, "auth.json"))) {
		await cp(join(liveAgentDir, "auth.json"), join(agentDir, "auth.json"));
	}
	await symlink(extensionDir, join(extensionLinkDir, "pi-quests"), "dir");
	const normalizedContext: ScenarioContext = {
		rootDir: await realpath(rootDir),
		agentDir: await realpath(agentDir),
		repoDir: await realpath(repoDir),
	};

	try {
		return await fn(normalizedContext);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
}

function repoPollutionCheck(repoDir: string) {
	return !existsSync(join(repoDir, ".pi")) && !existsSync(join(repoDir, "quest.json")) && !existsSync(join(repoDir, "quests"));
}

async function compatibilityJsonEvents(): Promise<ScenarioResult> {
	return await withScenarioSandbox("command-only", async (context) => {
		const result = await runPi(context, "Run printf compat-ok via bash, then reply with done.", ["--tools", "bash"]);
		const events = parseJsonLines(result.stdout).map((event) => event.type).filter(Boolean);
		const required = [
			"message_update",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"turn_end",
			"agent_end",
		];
		const missing = required.filter((type) => !events.includes(type));
		const passed = result.exitCode === 0 && missing.length === 0;
		return {
			id: "compatibility-json-events",
			title: "Pi JSON event stream exposes the event types quests depend on",
			passed,
			summary: passed ? "Observed all required Pi JSON event types for quest worker telemetry." : `Missing required event types: ${missing.join(", ") || "none"}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
			artifacts: {
				events,
				missing,
			},
		};
	});
}

async function questControlSurface(): Promise<ScenarioResult> {
	return await withScenarioSandbox("command-only", async (context) => {
		const quest = await createQuest(context.agentDir, context.repoDir, "Inspect the command surface split", {
			...scenarioModelChoice,
		});
		quest.status = "ready";
		quest.plan = {
			title: "Command surface split",
			summary: "Keep quest control and project quest listing separate.",
			successCriteria: ["Quest Control stays separate from the quest list."],
			milestones: [],
			features: [],
			validationContract: {
				summary: "No-op command surface scenario.",
				milestoneExpectations: [],
				featureChecks: [],
				criteria: [],
				weakValidationWarnings: [],
			},
		};
		await saveQuest(context.agentDir, quest);

		const control = await runPi(context, "/quest");
		const list = await runPi(context, "/quests");
		const passed =
			control.exitCode === 0 &&
			list.exitCode === 0 &&
			control.stdout.includes("Quest: Command surface split") &&
			control.stdout.includes("Next action: /quest accept") &&
			list.stdout.includes("Inspect the command surface split") &&
			list.stdout.includes("ready");

		return {
			id: "quest-control-surface",
			title: "Quest Control and /quests stay separate",
			passed,
			summary: passed ? "Quest Control rendered the active quest and /quests listed project quests separately." : `Quest control/list split failed.${control.stderr ? ` control: ${control.stderr.trim()}` : ""}${list.stderr ? ` list: ${list.stderr.trim()}` : ""}`,
			artifacts: {
				control: control.stdout,
				list: list.stdout,
			},
		};
	});
}

async function readonlyWebProposal(): Promise<ScenarioResult> {
	return await withScenarioSandbox("readonly-web", async (context) => {
		await createQuest(context.agentDir, context.repoDir, "Plan a tiny readonly code health audit for this repo.", {
			...scenarioModelChoice,
		});
		const result = await runPi(
			context,
			"Plan the active quest for this repo. Do not ask clarifying questions. Keep it to one milestone. Return the final quest JSON.",
		);
		const quest = await loadActiveQuest(context.agentDir, context.repoDir);
		const passed = result.exitCode === 0 && quest?.status === "ready" && Boolean(quest.plan?.validationContract) && repoPollutionCheck(context.repoDir);
		return {
			id: "readonly-web",
			title: "Readonly quest planning captures a proposal without repo pollution",
			passed,
			summary: passed ? "Readonly quest planning reached ready with a stored validation contract and no repo pollution." : `Readonly quest planning failed to reach ready.${result.stderr ? ` ${result.stderr.trim()}` : ""}`,
			artifacts: {
				status: quest?.status,
				hasPlan: Boolean(quest?.plan),
				validationCriteria: quest?.plan?.validationContract.criteria.length ?? 0,
				repoPollutionFree: repoPollutionCheck(context.repoDir),
			},
		};
	});
}

async function weakValidationWarning(): Promise<ScenarioResult> {
	return await withScenarioSandbox("weak-validation", async (context) => {
		await createQuest(context.agentDir, context.repoDir, "Plan a tiny README quality audit for this repo.", {
			...scenarioModelChoice,
		});
		const result = await runPi(
			context,
			"Plan the active quest for this repo. There are no automated checks, no browser surface, and validation is mostly static inspection plus human QA. Do not ask clarifying questions. Return the final quest JSON.",
		);
		const quest = await loadActiveQuest(context.agentDir, context.repoDir);
		const warnings = quest?.plan?.validationContract.weakValidationWarnings ?? [];
		const strategies = quest?.plan?.validationContract.criteria.map((criterion) => criterion.proofStrategy) ?? [];
		const passed =
			result.exitCode === 0 &&
			quest?.status === "ready" &&
			warnings.length > 0 &&
			(strategies.includes("read_only") || strategies.includes("manual"));
		return {
			id: "weak-validation-warning",
			title: "Weak validation planning surfaces explicit warnings",
			passed,
			summary: passed ? "Quest proposal captured explicit weak-validation warnings." : `Weak validation warnings were not captured clearly.${result.stderr ? ` ${result.stderr.trim()}` : ""}`,
			artifacts: {
				status: quest?.status,
				warnings,
				strategies,
			},
		};
	});
}

async function humanQaGate(): Promise<ScenarioResult> {
	return await withScenarioSandbox("command-only", async (context) => {
		const quest = await createQuest(context.agentDir, context.repoDir, "Finish human QA gate", {
			...scenarioModelChoice,
		});
		quest.status = "completed";
		quest.shipReadiness = "validated_waiting_for_human_qa";
		quest.humanQaStatus = "pending";
		quest.plan = {
			title: "Human QA gate",
			summary: "Require explicit approval before ship readiness flips.",
			successCriteria: ["Human QA stays explicit."],
			milestones: [
				{
					id: "m1",
					title: "Validate quest",
					summary: "Quest already validated",
					successCriteria: ["Quest is ready for human QA"],
					status: "completed",
				},
			],
			features: [
				{
					id: "f1",
					title: "Validation done",
					summary: "Validation is already complete",
					milestoneId: "m1",
					acceptanceCriteria: ["Human QA approval remains explicit"],
					status: "completed",
				},
			],
			validationContract: {
				summary: "Human QA remains separate from validation.",
				milestoneExpectations: [],
				featureChecks: [],
				criteria: [],
				weakValidationWarnings: [],
			},
		};
		await saveQuest(context.agentDir, quest);

		const result = await runPi(context, "/quest approve");
		const persisted = await loadActiveQuest(context.agentDir, context.repoDir);
		const passed = result.exitCode === 0 && persisted?.humanQaStatus === "approved" && persisted?.shipReadiness === "human_qa_complete";
		return {
			id: "human-qa-gate",
			title: "Human QA approval remains an explicit final step",
			passed,
			summary: passed ? "Quest approval required an explicit /quest approve step." : `Quest approval did not update the final QA state correctly.${result.stderr ? ` ${result.stderr.trim()}` : ""}`,
			artifacts: {
				humanQaStatus: persisted?.humanQaStatus,
				shipReadiness: persisted?.shipReadiness,
			},
		};
	});
}

async function abortRecovery(): Promise<ScenarioResult> {
	return await withScenarioSandbox("command-only", async (context) => {
		await writeFile(join(context.repoDir, "README.md"), "# Command Only Fixture\n", "utf-8");
		const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		sleeper.unref();

		const quest = await createQuest(context.agentDir, context.repoDir, "Resume unfinished work after operator abort", {
			...scenarioModelChoice,
		});
		quest.roleModels.worker = { ...scenarioModelChoice };
		quest.roleModels.validator = { ...scenarioModelChoice };
		quest.status = "running";
		quest.plan = {
			title: "Abort recovery",
			summary: "Abort and resume the remaining unfinished work.",
			successCriteria: ["Abort preserves completed work and resume only continues unfinished work."],
			milestones: [
				{
					id: "m1",
					title: "Recovery milestone",
					summary: "Finish the remaining recovery work",
					successCriteria: ["The remaining unfinished feature lands cleanly."],
					validationPrompt: "Verify README.md contains QUEST_ABORT_RECOVERY_OK and the test command still passes.",
					status: "running",
				},
			],
			features: [
				{
					id: "f1",
					title: "Keep completed work intact",
					summary: "This feature already completed before the abort",
					milestoneId: "m1",
					acceptanceCriteria: ["Completed work remains completed"],
					status: "completed",
					lastRunSummary: "Existing completed work",
				},
				{
					id: "f2",
					title: "Finish the interrupted recovery note",
					summary: "Append the recovery line to README.md",
					milestoneId: "m1",
					acceptanceCriteria: ["README.md contains QUEST_ABORT_RECOVERY_OK", "The repo test command passes"],
					workerPrompt: "Append the exact line QUEST_ABORT_RECOVERY_OK to README.md and nothing else.",
					status: "running",
				},
			],
			validationContract: {
				summary: "Abort recovery uses command and read-only proof paths.",
				milestoneExpectations: [
					{
						milestoneId: "m1",
						title: "Recovery milestone",
						expectedBehaviors: ["README.md contains QUEST_ABORT_RECOVERY_OK", "The repo test command passes"],
					},
				],
				featureChecks: [
					{ featureId: "f1", title: "Keep completed work intact", criterionIds: ["criterion-1"] },
					{ featureId: "f2", title: "Finish the interrupted recovery note", criterionIds: ["criterion-2", "criterion-3"] },
				],
				criteria: [
					{
						id: "criterion-1",
						title: "Completed work is preserved",
						milestoneId: "m1",
						featureIds: ["f1"],
						expectedBehavior: "Completed work remains completed",
						proofStrategy: "read_only",
						proofDetails: "Read quest state and confirm completed feature stays completed.",
						commands: [],
						confidence: "high",
					},
					{
						id: "criterion-2",
						title: "README recovery note exists",
						milestoneId: "m1",
						featureIds: ["f2"],
						expectedBehavior: "README.md contains QUEST_ABORT_RECOVERY_OK",
						proofStrategy: "read_only",
						proofDetails: "Read README.md after resume.",
						commands: [],
						confidence: "high",
					},
					{
						id: "criterion-3",
						title: "Repo tests pass",
						milestoneId: "m1",
						featureIds: ["f2"],
						expectedBehavior: "The repo test command passes",
						proofStrategy: "command",
						proofDetails: "Run bun test.",
						commands: ["bun test"],
						confidence: "high",
					},
				],
				weakValidationWarnings: [],
			},
		};
		quest.activeRun = {
			role: "worker",
			kind: "feature",
			pid: sleeper.pid,
			featureId: "f2",
			milestoneId: "m1",
			phase: "streaming",
			startedAt: Date.now() - 1000,
		};
		await saveQuest(context.agentDir, quest);

		const abortResult = await runPi(context, "/quest abort");
		const abortedQuest = await loadActiveQuest(context.agentDir, context.repoDir);
		const abortPassed =
			abortResult.exitCode === 0 &&
			abortedQuest?.status === "aborted" &&
			abortedQuest.plan?.features.find((feature) => feature.id === "f1")?.status === "completed" &&
			abortedQuest.plan?.features.find((feature) => feature.id === "f2")?.status === "blocked";

		const resumeResult = await runPi(context, "/quest resume");
		const resumedQuest = await loadActiveQuest(context.agentDir, context.repoDir);
		const readme = await readFile(join(context.repoDir, "README.md"), "utf-8");
		const resumePassed =
			resumeResult.exitCode === 0 &&
			resumedQuest?.plan?.features.find((feature) => feature.id === "f1")?.status === "completed" &&
			readme.includes("QUEST_ABORT_RECOVERY_OK") &&
			(resumedQuest?.status === "completed" || resumedQuest?.status === "paused");

		return {
			id: "abort-recovery",
			title: "Abort preserves completed work and resume continues only unfinished work",
			passed: abortPassed && resumePassed,
			summary:
				abortPassed && resumePassed
					? "Abort blocked only the interrupted work, and resume continued the remaining unfinished work."
					: `Abort or resume recovery failed.${abortResult.stderr ? ` abort: ${abortResult.stderr.trim()}` : ""}${resumeResult.stderr ? ` resume: ${resumeResult.stderr.trim()}` : ""}`,
			artifacts: {
				abortStatus: abortedQuest?.status,
				resumeStatus: resumedQuest?.status,
				recoveryLine: readme.includes("QUEST_ABORT_RECOVERY_OK"),
			},
		};
	});
}

async function validatorBlockReplan(): Promise<ScenarioResult> {
	return await withScenarioSandbox("command-only", async (context) => {
		await writeFile(join(context.repoDir, "README.md"), "# Command Only Fixture\n", "utf-8");
		const quest = await createQuest(context.agentDir, context.repoDir, "Revise only remaining unfinished work after validator feedback", {
			...scenarioModelChoice,
		});
		quest.roleModels.worker = { ...scenarioModelChoice };
		quest.roleModels.validator = { ...scenarioModelChoice };
		quest.roleModels.orchestrator = { ...scenarioModelChoice };
		quest.status = "paused";
		quest.plan = {
			title: "Validator replan",
			summary: "Preserve completed work while revising the remaining quest plan.",
			successCriteria: ["Completed work remains intact and pending revision requests clear."],
			milestones: [
				{
					id: "m1",
					title: "Completed baseline",
					summary: "Keep the existing baseline",
					successCriteria: ["Completed work stays completed"],
					status: "completed",
				},
				{
					id: "m2",
					title: "Remaining work",
					summary: "Finish the remaining follow-up",
					successCriteria: ["README contains QUEST_REPLAN_OK"],
					validationPrompt: "Verify README.md contains QUEST_REPLAN_OK.",
					status: "blocked",
				},
			],
			features: [
				{
					id: "f1",
					title: "Keep completed baseline",
					summary: "Already completed baseline work",
					milestoneId: "m1",
					acceptanceCriteria: ["Completed work remains completed"],
					status: "completed",
					lastRunSummary: "Baseline already landed",
				},
				{
					id: "f2",
					title: "Finish the remaining follow-up",
					summary: "Append the replan note to README.md",
					milestoneId: "m2",
					acceptanceCriteria: ["README.md contains QUEST_REPLAN_OK"],
					workerPrompt: "Append the exact line QUEST_REPLAN_OK to README.md and nothing else.",
					status: "pending",
				},
			],
			validationContract: {
				summary: "Replan stays bounded to unfinished work.",
				milestoneExpectations: [],
				featureChecks: [],
				criteria: [],
				weakValidationWarnings: [],
			},
		};
		quest.pendingPlanRevisionRequests = [
			{
				id: "request-1",
				source: "validator",
				note: "Revise only the remaining unfinished work. Preserve completed work and keep the quest serial.",
				createdAt: Date.now(),
				milestoneId: "m2",
			},
		];
		await appendQuestEvent(context.agentDir, context.repoDir, quest.id, {
			ts: Date.now(),
			type: "milestone_blocked",
			data: { milestoneId: "m2", title: "Remaining work", summary: "Synthetic validator block for scenario eval." },
		});
		await saveQuest(context.agentDir, quest);

		const result = await runPi(context, "/quest resume");
		const persisted = await loadActiveQuest(context.agentDir, context.repoDir);
		const readme = await readFile(join(context.repoDir, "README.md"), "utf-8");
		const passed =
			result.exitCode === 0 &&
			(persisted?.pendingPlanRevisionRequests.length ?? 0) === 0 &&
			persisted?.plan?.features.find((feature) => feature.id === "f1")?.status === "completed" &&
			(readme.includes("QUEST_REPLAN_OK") || persisted?.status === "completed" || persisted?.status === "paused");

		return {
			id: "validator-block-replan",
			title: "Validator-triggered replans revise only unfinished work",
			passed,
			summary: passed ? "Validator-triggered replan preserved completed work and cleared pending revision requests." : `Validator-triggered replan did not stay bounded to unfinished work.${result.stderr ? ` ${result.stderr.trim()}` : ""}`,
			artifacts: {
				status: persisted?.status,
				pendingRequests: persisted?.pendingPlanRevisionRequests.length,
				completedBaselineStatus: persisted?.plan?.features.find((feature) => feature.id === "f1")?.status,
				readmeContainsMarker: readme.includes("QUEST_REPLAN_OK"),
			},
		};
	});
}

const scenarios = [
	compatibilityJsonEvents,
	questControlSurface,
	readonlyWebProposal,
	weakValidationWarning,
	humanQaGate,
	abortRecovery,
	validatorBlockReplan,
];

async function main() {
	const results: ScenarioResult[] = [];
	const filter = process.env.SCENARIO_FILTER?.trim();
	for (const scenario of scenarios) {
		if (filter && !scenario.name.toLowerCase().includes(filter.toLowerCase())) continue;
		results.push(await scenario());
	}

	let passed = 0;
	for (const result of results) {
		const status = result.passed ? "PASS" : "FAIL";
		if (result.passed) passed += 1;
		console.log(`[scenario] ${status} ${result.id} - ${result.summary}`);
		if (!result.passed && result.artifacts) {
			console.log(`[scenario] artifacts ${result.id} ${JSON.stringify(result.artifacts)}`);
		}
	}

	console.log(`[scenario] ${passed}/${results.length} passed`);
	if (passed !== results.length) process.exitCode = 1;
}

await main();
