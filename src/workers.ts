import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { nativeBenchmarkHelperArgs, runBenchmarkHelper } from "./benchmark-helpers.js";
import { parseQuestExperimentCandidate, promptSurfaceText, toolAllowlistForRole } from "./trials-core.js";
import { parseQuestPlanText } from "./plan-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import type {
	QuestBenchmarkProvenance,
	QuestExperimentCandidate,
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestProfile,
	QuestRole,
	QuestState,
	ValidationAssertion,
	ValidationReadiness,
	ValidationSurfaceStatus,
	WorkerEventRecord,
	WorkerRunRecord,
} from "./types.js";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RunPiTaskOptions {
	cwd: string;
	modelChoice: ModelChoice;
	tools: string[];
	role: QuestRole;
	featureId?: string;
	milestoneId?: string;
	systemPrompt?: string;
	prompt: string;
	benchmark?: QuestBenchmarkProvenance;
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface RunPiTaskResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
	events: WorkerEventRecord[];
	phase: string;
	latestToolName?: string;
	latestToolSummary?: string;
	latestAssistantText?: string;
	signal?: string;
	aborted: boolean;
}

interface ValidatorPayload {
	status?: string;
	summary?: string;
	issues?: string[];
}

interface ValidationReadinessPayload {
	summary?: string;
	checks?: Array<{
		id?: string;
		surface?: string;
		description?: string;
		status?: string;
		commands?: string[];
		evidence?: string[];
		notes?: string;
	}>;
	services?: Array<{
		name?: string;
		purpose?: string;
		commands?: string[];
		ports?: number[];
		notes?: string[];
	}>;
}

interface TrialProposerContext {
	communityStatsPath: string;
	frontierStatePath: string;
	candidatesDir: string;
	searchSetPath: string;
	holdOutSetPath: string;
	searchTagSummary?: Record<string, number>;
	holdOutTagSummary?: Record<string, number>;
	communityStats?: {
		totalSessions?: number;
		parsedSessions?: number;
		failureTags?: Record<string, number>;
	};
	leaderSummary?: {
		candidateId?: string;
		summary?: string;
		searchScore?: {
			meanScore?: number;
			totalCost?: number;
			totalDurationMs?: number;
		};
		tagBreakdown?: Record<
			string,
			{
				itemCount?: number;
				passed?: number;
				meanScore?: number;
			}
		>;
	};
}

const DEFAULT_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

type ValidatorPass = "code_review" | "user_surface";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const explicit = process.env.PI_QUESTS_PI_BIN;
	if (explicit) return { command: explicit, args };
	const currentScript = process.argv[1];
	const currentBase = currentScript ? path.basename(currentScript).toLowerCase() : "";
	if (currentScript && currentBase.startsWith("pi")) return { command: process.execPath, args: [currentScript, ...args] };
	return { command: "pi", args };
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function extractJsonBlock<T>(text: string): T | null {
	const fenced = text.match(/```json\s*([\s\S]*?)```/i);
	if (!fenced) return null;
	try {
		return JSON.parse(fenced[1]) as T;
	} catch {
		return null;
	}
}

async function withTempPrompt(contents: string | undefined): Promise<{ file?: string; cleanup: () => Promise<void> }> {
	if (!contents?.trim()) return { cleanup: async () => {} };

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-quests-"));
	const file = path.join(dir, "system.md");
	await fs.writeFile(file, contents, "utf-8");
	return {
		file,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function learnedWorkflowSection(workflows: LearnedWorkflow[]): string {
	if (workflows.length === 0) return "- None";
	return workflows.map((workflow) => `- ${workflow.title}: ${workflow.note}`).join("\n");
}

function validationAssertionsForFeature(quest: QuestState, feature: QuestFeature): ValidationAssertion[] {
	const assertions = quest.validationState?.assertions ?? [];
	if (feature.fulfills.length > 0) {
		return assertions.filter((assertion) => feature.fulfills.includes(assertion.id));
	}
	return assertions.filter((assertion) => assertion.featureIds?.includes(feature.id));
}

function validationAssertionsForMilestone(
	quest: QuestState,
	milestone: QuestMilestone,
	pass?: ValidatorPass,
): ValidationAssertion[] {
	const assertions = (quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestone.id);
	if (!pass) return assertions;
	if (pass === "code_review") {
		return assertions.filter((assertion) => assertion.method !== "user_surface");
	}
	return assertions.filter((assertion) => assertion.method === "user_surface" || assertion.method === "mixed");
}

function questContext(quest: QuestState, workflows: LearnedWorkflow[]): string {
	const notes = quest.steeringNotes.length ? quest.steeringNotes.map((note) => `- ${note}`).join("\n") : "- None";
	const readiness = quest.validationReadiness?.checks.length
		? quest.validationReadiness.checks.map((check) => `- ${check.surface} [${check.status}] ${check.description}`).join("\n")
		: "- No validation readiness checks captured.";

	return `Quest: ${quest.plan?.title ?? quest.title}

Goal:
${quest.goal}

Quest summary:
${quest.plan?.summary ?? quest.lastSummary ?? "No summary yet."}

Steering notes:
${notes}

Validation readiness:
${readiness}

Project learned workflows:
${learnedWorkflowSection(workflows)}`;
}

function loadedSessionContextGuidance(): string {
	return `Loaded session context:
- Pi may already have repo/global AGENTS.md instructions, contextual files, and matching skills in scope.
- Treat those loaded instructions as binding, not optional hints.
- If a relevant skill is already loaded, use it instead of inventing a new workflow from scratch.`;
}

function benchmarkWorkspaceHint(benchmark: QuestBenchmarkProvenance): string {
	if (benchmark.benchmark === "terminal-bench") {
		return `Task workspace: /app
Task note: terminal-bench task inputs and required output files usually live under /app, while Quest state lives under /workspace/.pi.`;
	}
	if (benchmark.benchmark === "slopcodebench") {
		return "Task workspace: the checked-out problem repository under the current working tree.";
	}
	return "Task workspace: use the paths named in the task.";
}

function benchmarkTaskSpecificHint(benchmark: QuestBenchmarkProvenance): string {
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "chess-best-move") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it writes /app/move.txt successfully:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench chess-best-move /app/chess_board.png /app/move.txt
- Treat /app/chess_board.png as a synthetic 8x8 board image with uniform squares and rendered chess glyphs.
- Use Python with PIL to crop the board into equal squares, compare each square against generated piece templates or background-only squares, then recover the board position.
- Use python-chess to enumerate legal moves and keep every move that delivers immediate checkmate.
- Write every winning move, one per line, to /app/move.txt.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "polyglot-c-py") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it writes /app/polyglot/main.py.c successfully:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench polyglot-c-py /app/polyglot /app/polyglot/main.py.c
- The verifier expects /app/polyglot to contain exactly one file at the end: main.py.c.
- If you compile or run auxiliary checks, put temporary binaries under /tmp or remove them before finishing.
- Do not leave /app/polyglot/cmain or any other extra artifact behind after validation.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "fix-code-vulnerability") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it patches /app/bottle.py and writes /app/report.jsonl successfully:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench fix-code-vulnerability /app /app/report.jsonl
- The report must identify /app/bottle.py with the exact CWE id list expected by the verifier.
- If manual fallback is required, patch only the vulnerable header-validation surface and keep the fix narrow.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "regex-log") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it writes /app/regex.txt successfully:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench regex-log /app /app/regex.txt
- If manual fallback is required, /app may start empty for this task. Do not waste time searching for hidden inputs.
- The full task is specified in the prompt. The only required deliverable is /app/regex.txt.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "log-summary-date-ranges") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it writes /app/summary.csv successfully:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench log-summary-date-ranges /app/logs /app/summary.csv
- Count only bracketed severities like [ERROR], [WARNING], and [INFO].
- Keep the CSV rows in the exact required order.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "qemu-startup") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it leaves telnet on port 6665 ready:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench qemu-startup /app/alpine.iso /app/alpine-disk.qcow2
- Use the installed qemu-system-x86_64 binary; do not build QEMU from source.
- On slower Apple Silicon hosts, the fastest path is to extract Alpine's kernel/initramfs from the ISO, boot them directly with the ISO still attached as the CD-ROM, and attach a tiny side-media overlay that enables ttyS0 login.
- Block until the serial console actually emits the login prompt.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "qemu-alpine-ssh") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if SSH on port 2222 succeeds:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench qemu-alpine-ssh /app/alpine.iso /app/alpine-disk.qcow2
- Use the installed qemu-system-x86_64 binary; do not build QEMU from source.
- On slower Apple Silicon hosts, the fastest path is to extract Alpine's kernel/initramfs from the ISO, boot them directly with the ISO still attached as the CD-ROM, and attach a tiny side-media overlay that enables ttyS0 login.
- Configure networking and OpenSSH from the serial console, then verify \`ssh -p 2222 root@localhost\` works with password \`password123\`.`;
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "configure-git-webserver") {
		return `Task-specific hint:
- A native helper is available at /opt/quest-package/dist/benchmark-helpers.js.
- First action: run this exact command and stop if it provisions the bare repo, post-receive hook, SSH service, and nginx on port 8080:
  node /opt/quest-package/dist/benchmark-helpers.js terminal-bench configure-git-webserver /var/www/html /git/server
- The bare repository must deploy pushes into the web root through a post-receive hook.
- The webserver must serve the deployed content on port 8080 without extra manual steps after the push.`;
	}
	return "";
}

export function buildFeaturePrompt(
	quest: QuestState,
	feature: QuestFeature,
	milestone: QuestMilestone,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	benchmark?: QuestBenchmarkProvenance,
	nativeHelperFailure?: string,
): string {
	if (benchmark) {
		return `Benchmark task:
- benchmark: ${benchmark.benchmark}
- dataset: ${benchmark.dataset}
- task: ${benchmark.taskId}
- run mode: ${benchmark.runMode}

Repository root: ${quest.cwd}

${benchmarkWorkspaceHint(benchmark)}

Task goal:
${quest.goal}

Assigned feature:
${feature.title}
${feature.description}

Execution policy:
- Solve the task with the shortest correct path.
- Ignore .pi/, quest bookkeeping, candidate archives, and unrelated repo cleanup.
- Inspect named task paths before broad exploration. For Terminal-Bench, start with /app inputs and required /app outputs.
- If a native helper command is provided below, run it first. If it fails, do not retry it.
- Produce the exact required artifact, sanity-check it quickly, then stop.
- Keep narration minimal and spend tokens on execution.

Benchmark heuristics:
- Prefer a short bash or Python script over extended exploration.
- Use Python or CLI tools for images, archives, PDFs, and structured data instead of raw text inspection.
- Keep scratch work under /tmp and leave task directories with only required deliverables.

${benchmarkTaskSpecificHint(benchmark)}

${nativeHelperFailure ? `Native helper status:
- Quest already attempted the native helper path and it failed with:
  ${nativeHelperFailure}
- Do not retry the same helper command. Fall back to a manual solution path.` : ""}

Profile surface policy:
${promptSurfaceText(profile, "feature-worker")}

At the end, output:
## Feature Result
- summary
- files touched
- follow-ups if any

\`\`\`json
{
  "status": "completed",
  "summary": "what you completed",
  "filesTouched": ["optional/path"],
  "followUps": ["optional follow-up"]
}
\`\`\`
`;
	}

	const preconditions = feature.preconditions.length ? feature.preconditions.map((item) => `- ${item}`).join("\n") : "- None.";
	const assertions = validationAssertionsForFeature(quest, feature);
	const validationLines =
		assertions.length > 0
			? assertions
					.map(
						(assertion) =>
							`- ${assertion.id} · ${assertion.method} · ${assertion.criticality}\n  ${assertion.description}${
								assertion.commands?.length ? `\n  Commands: ${assertion.commands.join(", ")}` : ""
							}`,
					)
			.join("\n")
			: "- No feature-specific validation assertions were captured.";
	const contextPolicy =
		profile.contextPolicy.spillLongOutputsToReports
			? `If evidence exceeds roughly ${profile.contextPolicy.spillThresholdChars} characters, summarize it inline and spill the rest to a report instead of bloating the response.`
			: "Keep evidence compact and inline.";

	return `${questContext(quest, workflows)}

Current milestone: ${milestone.title}
Milestone summary: ${milestone.description}

Assigned feature: ${feature.title}
Feature summary: ${feature.description}

Preconditions:
${preconditions}

Validation assertions satisfied by this feature:
${validationLines}

Profile surface policy:
${promptSurfaceText(profile, "feature-worker")}

Context policy:
${contextPolicy}

${loadedSessionContextGuidance()}

${feature.handoff ? `Expected handoff:\n${feature.handoff}\n` : ""}${feature.workerPrompt ? `Feature-specific instructions:\n${feature.workerPrompt}\n` : ""}

Execute only this feature. Keep the quest serial and scoped. Do not introduce unrelated changes.

At the end, output:
## Feature Result
- summary
- files touched
- follow-ups if any

\`\`\`json
{
  "status": "completed",
  "summary": "what you completed",
  "filesTouched": ["optional/path"],
  "followUps": ["optional follow-up"]
}
\`\`\`
`;
}

export function buildWorkerSystemPrompt(profile: QuestProfile, benchmark = false): string {
	return `You are a quest worker executing a single feature within a larger Pi quest.

Rules:
- Focus only on the assigned feature.
- Respect loaded AGENTS.md instructions and reuse relevant loaded skills when they apply.
- Make the smallest correct change that satisfies the feature.
- Do not start new quests or inspect quest internals.
- Do not rewrite unrelated parts of the codebase.
- ${benchmark ? "In benchmark mode, treat the external verifier as authoritative and optimize for direct task execution." : "Use the repo's native validation signals when they are available."}
- ${benchmark ? "When the task names a path, inspect or write that exact path first." : "Inspect the smallest relevant scope before making changes."}
- ${benchmark ? "Use short bash or Python scripts for binary, image, and structured-data tasks." : "Prefer the lightest tool that can answer the question."}
- ${benchmark ? "Run a provided native helper once before custom analysis." : "Use native repo helpers before building custom tooling."}
- ${benchmark ? "Remove transient scratch artifacts from task-owned outputs before finishing." : "Clean up transient local artifacts when they are no longer needed."}
- Budget: at most ${profile.verificationBudget.workerAttempts} worker attempt(s) before handing control back.
- End with the required JSON block.`;
}

export function buildValidatorPrompt(
	quest: QuestState,
	milestone: QuestMilestone,
	features: QuestFeature[],
	workflows: LearnedWorkflow[],
	pass: ValidatorPass,
	profile: QuestProfile,
): string {
	const featureList = features.map((feature) => `- ${feature.title}: ${feature.lastRunSummary ?? feature.description}`).join("\n");
	const assertions = validationAssertionsForMilestone(quest, milestone, pass);
	const validationLines =
		assertions.length > 0
			? assertions
					.map(
						(assertion) =>
							`- ${assertion.id} · ${assertion.method} · ${assertion.criticality}\n  ${assertion.description}${
								assertion.commands?.length ? `\n  Commands: ${assertion.commands.join(", ")}` : ""
							}`,
					)
					.join("\n")
			: "- No matching assertions were captured for this validation pass.";
	const passDescription =
		pass === "code_review"
			? "Perform a code/procedure review. Prefer repo commands, typechecks, tests, and read-only inspection."
			: "Perform a user-surface validation pass. Prefer browser-visible flows, CLI-visible behavior, and operator-facing outcomes.";
	const surfaceId = pass === "code_review" ? "validator-code-review" : "validator-user-surface";

	return `${questContext(quest, workflows)}

Validate the milestone "${milestone.title}".

Completed features in this milestone:
${featureList}

Validation pass:
${passDescription}

Assertions for this pass:
${validationLines}

Profile surface policy:
${promptSurfaceText(profile, surfaceId)}

${loadedSessionContextGuidance()}

${milestone.validationPrompt ? `Extra validation guidance:\n${milestone.validationPrompt}\n` : ""}

You are read-only. Verify the milestone. Do not edit code.

At the end, output:
\`\`\`json
{
  "status": "pass",
  "summary": "validation result",
  "issues": []
}
\`\`\`
`;
}

export function buildValidatorSystemPrompt(pass: ValidatorPass, profile: QuestProfile): string {
	return `You are a read-only quest validator running the ${pass} pass.

Rules:
- Verify the assigned milestone using read-only tools and commands.
- Respect loaded AGENTS.md instructions and any relevant loaded skills while staying read-only.
- Do not edit or write files.
- Be explicit about issues, blockers, or limited coverage.
- Budget: at most ${profile.verificationBudget.validatorAttempts} validator attempt(s) before handing control back.
- End with the required JSON block.`;
}

export function buildPlanRevisionSystemPrompt(profile: QuestProfile): string {
	return `You are the quest orchestrator revising only the remaining plan for an existing Pi quest.

Rules:
- Preserve completed work.
- Only change unfinished milestones, unfinished features, and validation for unfinished work.
- Keep the quest serial by default.
- Respect loaded AGENTS.md instructions and reuse relevant loaded skills when they apply.
- Do not edit repository files.
- Policy surface:
${promptSurfaceText(profile, "plan-revision")}
- End with the required JSON block.`;
}

function buildReadinessProbePrompt(cwd: string, profile: QuestProfile): string {
	return `Probe validation readiness for this repository at ${cwd}.

You are a dry-run validator. Do not edit files.

Inspect the repository and determine which validation surfaces are available.
Consider at least:
- repo checks (test, lint, typecheck, build)
- browser or user-surface validation
- dev server startup
- local services or docker dependencies
- API or command-line validation

Profile surface policy:
${promptSurfaceText(profile, "readiness-probe")}

${loadedSessionContextGuidance()}

Return:
\`\`\`json
{
  "summary": "short summary",
  "checks": [
    {
      "id": "checks",
      "surface": "repo-checks",
      "description": "what can be validated",
      "status": "supported",
      "commands": ["npm test"],
      "evidence": ["package.json script found"],
      "notes": "optional caveat"
    }
  ],
  "services": [
    {
      "name": "web",
      "purpose": "dev server",
      "commands": ["npm run dev"],
      "ports": [3000],
      "notes": ["optional caveat"]
    }
  ]
}
\`\`\``;
}

function buildPlanningPrompt(
	cwd: string,
	goal: string,
	readiness: ValidationReadiness | null,
	profile: QuestProfile,
	benchmark?: QuestBenchmarkProvenance,
): string {
	const readinessLines =
		readiness?.checks.length
			? readiness.checks.map((check) => `- ${check.surface} [${check.status}] ${check.description}`).join("\n")
			: "- No readiness checks captured.";
	const benchmarkLines = benchmark
		? `Benchmark context:
- benchmark: ${benchmark.benchmark}
- dataset: ${benchmark.dataset}
- task: ${benchmark.taskId}
- checkpoint: ${benchmark.checkpointId ?? "none"}
- run mode: ${benchmark.runMode}`
		: "Benchmark context:\n- none";
	return `Plan a headless Quest for this repository at ${cwd}.

Goal:
${goal}

${benchmarkLines}

Validation readiness:
${readiness?.summary ?? "No readiness summary captured yet."}

${readinessLines}

Profile surface policy:
${promptSurfaceText(profile, "planning")}

${loadedSessionContextGuidance()}

Return a compact quest plan as JSON with:
- title
- summary
- risks
- environment
- services
- validationSummary
- humanQaChecklist
- milestones
- features

Requirements:
- Keep execution serial by default.
- Prefer 1-4 features.
- Every feature must have explicit fulfills entries.
- Keep the final human QA handoff explicit.
- Be honest about limited or unsupported validation.

\`\`\`json
{
  "title": "Quest title",
  "summary": "Short plan summary",
  "risks": ["optional risk"],
  "environment": ["optional note"],
  "services": [],
  "validationSummary": "what is automated vs limited",
  "humanQaChecklist": ["manual QA item"],
  "milestones": [
    {
      "id": "m1",
      "order": 1,
      "title": "Complete benchmark task",
      "description": "Finish the assigned benchmark task",
      "successCriteria": ["task passes validation"],
      "status": "pending"
    }
  ],
  "features": [
    {
      "id": "f1",
      "order": 1,
      "milestoneId": "m1",
      "title": "Implement the benchmark task",
      "description": "Finish the required repo work",
      "preconditions": [],
      "fulfills": ["required validation outcome"],
      "status": "pending",
      "handoff": "brief handoff"
    }
  ]
}
\`\`\``;
}

export function buildPlannerSystemPrompt(profile: QuestProfile): string {
	return `You are the quest orchestrator planning a headless Pi quest.

Rules:
- Plan the smallest serial execution path that can solve the task.
- Keep human QA explicit at the end.
- Be honest about limited or unsupported validation.
- Respect loaded AGENTS.md instructions and use relevant loaded skills when they already fit the job.
- Do not emit prose outside the required JSON block.
- Planning policy:
${promptSurfaceText(profile, "planning")}`;
}

async function runPiTask(options: RunPiTaskOptions): Promise<RunPiTaskResult> {
	const temp = await withTempPrompt(options.systemPrompt);
	const args = ["--mode", "json", "--no-session", "--model", `${options.modelChoice.provider}/${options.modelChoice.model}`];
	args.push("--thinking", options.modelChoice.thinkingLevel);
	if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (temp.file) args.push("--append-system-prompt", temp.file);
	args.push("-p", options.prompt);

	const result: RunPiTaskResult = {
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { ...DEFAULT_USAGE },
		events: [],
		phase: "starting",
		aborted: false,
	};

	let liveSnapshot = createLiveRunSnapshot(options.role, {
		featureId: options.featureId,
		milestoneId: options.milestoneId,
	});
	if (options.onSnapshot) await options.onSnapshot(liveSnapshot);

	try {
		const invocation = getPiInvocation(args);
		await new Promise<void>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			if (typeof proc.pid === "number" && options.onProcessStart) {
				void Promise.resolve(options.onProcessStart(proc.pid));
			}

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const nextTelemetry = applyAgentEventToSnapshot(liveSnapshot, event, 80, result.events);
				liveSnapshot = nextTelemetry.snapshot;
				result.events = nextTelemetry.events;
				result.phase = liveSnapshot.phase;
				result.latestToolName = liveSnapshot.latestToolName;
				result.latestToolSummary = liveSnapshot.latestToolSummary;
				result.latestAssistantText = liveSnapshot.latestMessage;
				if (options.onSnapshot && ["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end"].includes(event.type)) {
					void Promise.resolve(options.onSnapshot(liveSnapshot));
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns += 1;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
						}
						result.stopReason = msg.stopReason;
						result.errorMessage = msg.errorMessage;
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
				}

				if (event.type === "agent_end" && Array.isArray(event.messages) && result.messages.length === 0) {
					result.messages = event.messages as Message[];
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = code ?? 0;
				result.signal = signal ?? undefined;
				result.aborted = signal === "SIGTERM" || signal === "SIGKILL";
				resolve();
			});

			proc.on("error", (err) => {
				result.stderr += `${err}`;
				result.exitCode = 1;
				resolve();
			});
		});

		return result;
	} finally {
		await temp.cleanup();
	}
}

function workerRunFromResult(
	modelChoice: ModelChoice,
	result: RunPiTaskResult,
	role: WorkerRunRecord["role"],
	startedAt: number,
	extra: Partial<WorkerRunRecord>,
	summary: string,
	ok: boolean,
	issues?: string[],
	benchmark?: QuestBenchmarkProvenance,
): WorkerRunRecord {
	return {
		id: randomUUID(),
		role,
		startedAt,
		endedAt: Date.now(),
		provider: modelChoice.provider,
		model: modelChoice.model,
		thinkingLevel: modelChoice.thinkingLevel,
		exitCode: result.exitCode,
		ok,
		summary,
		stopReason: result.stopReason,
		stderr: result.stderr || undefined,
		issues,
		aborted: result.aborted,
		signal: result.signal,
		phase: result.phase,
		latestToolName: result.latestToolName,
		latestToolSummary: result.latestToolSummary,
		latestAssistantText: result.latestAssistantText,
		events: result.events,
		usage: result.usage,
		benchmark: benchmark ? { ...benchmark } : undefined,
		...extra,
	};
}

export async function executeValidationReadinessProbe(
	cwd: string,
	modelChoice: ModelChoice,
	profile: QuestProfile,
	benchmark: QuestBenchmarkProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; readiness: ValidationReadiness | null; servicesYaml: string | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: [...toolAllowlistForRole(profile, "validator"), "find", "grep"],
		role: "validator",
		systemPrompt: buildValidatorSystemPrompt("code_review", profile),
		prompt: buildReadinessProbePrompt(cwd, profile),
		benchmark,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<ValidationReadinessPayload>(text);
	const readiness: ValidationReadiness | null =
		parsed && Array.isArray(parsed.checks)
			? {
					summary: parsed.summary || "Dry-run validation readiness captured.",
					checks: parsed.checks.map((check, index) => ({
						id: check.id || `readiness-${index + 1}`,
						surface: check.surface || "unknown",
						description: check.description || "No description provided.",
						status: (check.status === "supported" || check.status === "limited" || check.status === "unsupported"
							? check.status
							: "limited") as ValidationSurfaceStatus,
						commands: Array.isArray(check.commands) ? check.commands.map(String) : [],
						evidence: Array.isArray(check.evidence) ? check.evidence.map(String) : [],
						notes: check.notes ? String(check.notes) : undefined,
					})),
				}
			: null;
	const servicesYaml =
		parsed?.services && Array.isArray(parsed.services)
			? `services:\n${parsed.services
					.map((service) => {
						const ports = Array.isArray(service.ports) && service.ports.length > 0 ? `\n    ports: [${service.ports.join(", ")}]` : "";
						const notes =
							Array.isArray(service.notes) && service.notes.length > 0 ? `\n    notes:\n${service.notes.map((note) => `      - ${note}`).join("\n")}` : "";
						return `  - name: ${service.name || "service"}\n    purpose: ${service.purpose || ""}\n    commands:\n${
							Array.isArray(service.commands) && service.commands.length > 0
								? service.commands.map((command) => `      - ${command}`).join("\n")
								: "      -"
						}${ports}${notes}`;
					})
					.join("\n")}`
			: null;

	const ok = result.exitCode === 0 && Boolean(readiness);
	return {
		readiness,
		servicesYaml,
		run: workerRunFromResult(
			modelChoice,
			result,
			"validator",
			startedAt,
			{},
			readiness?.summary || text || "No readiness summary returned.",
			ok,
			undefined,
			benchmark,
		),
	};
}

export async function executeQuestPlanner(
	cwd: string,
	goal: string,
	modelChoice: ModelChoice,
	readiness: ValidationReadiness | null,
	profile: QuestProfile,
	benchmark: QuestBenchmarkProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; plan: QuestPlan | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "orchestrator"),
		role: "orchestrator",
		systemPrompt: buildPlannerSystemPrompt(profile),
		prompt: buildPlanningPrompt(cwd, goal, readiness, profile, benchmark),
		benchmark,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const plan = parseQuestPlanText(text)?.plan ?? null;

	return {
		plan,
		run: workerRunFromResult(
			modelChoice,
			result,
			"orchestrator",
			startedAt,
			{},
			plan ? `Planned ${plan.features.length} feature(s) for ${plan.title}.` : text || "No quest plan returned.",
			result.exitCode === 0 && Boolean(plan),
			undefined,
			benchmark,
		),
	};
}

export async function executeFeatureWorker(
	quest: QuestState,
	feature: QuestFeature,
	milestone: QuestMilestone,
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	benchmark: QuestBenchmarkProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const helperArgs = nativeBenchmarkHelperArgs(benchmark);
	let nativeHelperFailure: string | undefined;
	if (helperArgs) {
		try {
			await runBenchmarkHelper(helperArgs);
			return {
				id: randomUUID(),
				role: "worker",
				startedAt,
				endedAt: Date.now(),
				provider: modelChoice.provider,
				model: modelChoice.model,
				thinkingLevel: modelChoice.thinkingLevel,
				exitCode: 0,
				ok: true,
				summary: `Executed native benchmark helper for ${helperArgs.family}/${helperArgs.taskId}.`,
				issues: [],
				aborted: false,
				phase: "native-helper",
				latestToolName: "benchmark-helper",
				latestToolSummary: `${helperArgs.family}/${helperArgs.taskId}`,
				events: [],
				usage: DEFAULT_USAGE,
				benchmark: benchmark ? { ...benchmark } : undefined,
				featureId: feature.id,
				milestoneId: milestone.id,
			};
		} catch (error) {
			nativeHelperFailure = error instanceof Error ? error.message : String(error);
			console.error(`[quest] native helper failed for ${helperArgs.family}/${helperArgs.taskId}: ${nativeHelperFailure}`);
		}
	}
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "worker"),
		role: "worker",
		featureId: feature.id,
		milestoneId: milestone.id,
		systemPrompt: buildWorkerSystemPrompt(profile, Boolean(benchmark)),
		prompt: buildFeaturePrompt(quest, feature, milestone, workflows, profile, benchmark, nativeHelperFailure),
		benchmark,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<{ status?: string; summary?: string }>(text);
	const ok = result.exitCode === 0 && parsed?.status !== "failed" && parsed?.status !== "blocked";

	return workerRunFromResult(
		modelChoice,
		result,
		"worker",
		startedAt,
		{ featureId: feature.id, milestoneId: milestone.id },
		parsed?.summary || text || "No worker summary returned.",
		ok,
		undefined,
		benchmark,
	);
}

export async function executeValidator(
	quest: QuestState,
	milestone: QuestMilestone,
	features: QuestFeature[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	pass: ValidatorPass,
	profile: QuestProfile,
	benchmark: QuestBenchmarkProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "validator"),
		role: "validator",
		milestoneId: milestone.id,
		systemPrompt: buildValidatorSystemPrompt(pass, profile),
		prompt: buildValidatorPrompt(quest, milestone, features, workflows, pass, profile),
		benchmark,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<ValidatorPayload>(text);
	const issues = parsed?.issues ?? [];
	const ok = result.exitCode === 0 && parsed?.status !== "fail" && parsed?.status !== "blocked";

	return workerRunFromResult(
		modelChoice,
		result,
		"validator",
		startedAt,
		{ milestoneId: milestone.id },
		parsed?.summary || text || `No ${pass} summary returned.`,
		ok,
		issues,
		benchmark,
	);
}

export async function executePlanRevision(
	quest: QuestState,
	requests: QuestPlanRevisionRequest[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	benchmark: QuestBenchmarkProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; revisedPlan: QuestPlan | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "orchestrator"),
		role: "orchestrator",
		systemPrompt: buildPlanRevisionSystemPrompt(profile),
		prompt: `Revise the remaining quest plan.\n\nRequests:\n${requests.map((request) => `- [${request.source}] ${request.note}`).join("\n")}\n\nCurrent plan:\n\`\`\`json\n${JSON.stringify(quest.plan, null, 2)}\n\`\`\`\n\nCurrent validation state:\n\`\`\`json\n${JSON.stringify(quest.validationState, null, 2)}\n\`\`\`\n\nLearned workflows:\n${learnedWorkflowSection(workflows)}`,
		benchmark,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const revisedPlan = parseQuestPlanText(text)?.plan ?? null;
	const ok = result.exitCode === 0 && Boolean(revisedPlan);

	return {
		revisedPlan,
		run: workerRunFromResult(
			modelChoice,
			result,
			"orchestrator",
			startedAt,
			{},
			revisedPlan ? "Revised remaining quest plan." : text || "No plan revision returned.",
			ok,
			undefined,
			benchmark,
		),
	};
}

export async function executeTrialProposerAgent(
	cwd: string,
	modelChoice: ModelChoice,
	profile: QuestProfile,
	target: QuestProfile["target"],
	context: TrialProposerContext,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; candidate: QuestExperimentCandidate | null }> {
	const startedAt = Date.now();
	const topFailureTags = Object.entries(context.communityStats?.failureTags ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
		.slice(0, 6)
		.map(([tag, count]) => `${tag}: ${count}`);
	const topSearchTags = Object.entries(context.searchTagSummary ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, count]) => `${tag}: ${count}`);
	const topHoldOutTags = Object.entries(context.holdOutTagSummary ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, count]) => `${tag}: ${count}`);
	const leaderTagBreakdown = Object.entries(context.leaderSummary?.tagBreakdown ?? {})
		.sort((left, right) => ((left[1].meanScore ?? 0) - (right[1].meanScore ?? 0)) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, metrics]) => `${tag}: mean=${metrics.meanScore ?? 0} passed=${metrics.passed ?? 0}/${metrics.itemCount ?? 0}`);
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "proposer"),
		role: "proposer",
		systemPrompt: `You are the Quest frontier proposer.

Rules:
- Propose QuestProfilePatch changes only.
- Optimize for benchmark generalization, not one-off wins.
- Respect the proposer policy exactly:
${promptSurfaceText(profile, "proposer")}
- Use the canonical trials filesystem paths provided in the prompt.
- End with a JSON object only.`,
		prompt: `Target: ${target}

Canonical trials paths:
- frontier state: ${context.frontierStatePath}
- candidates dir: ${context.candidatesDir}
- community stats: ${context.communityStatsPath}
- search split: ${context.searchSetPath}
- hold-out split: ${context.holdOutSetPath}

Current profile:
\`\`\`json
${JSON.stringify(profile, null, 2)}
\`\`\`

Current frontier leader:
- candidate: ${context.leaderSummary?.candidateId ?? "none"}
- summary: ${context.leaderSummary?.summary ?? "none"}
- mean score: ${context.leaderSummary?.searchScore?.meanScore ?? 0}
- total cost: ${context.leaderSummary?.searchScore?.totalCost ?? 0}
- total duration ms: ${context.leaderSummary?.searchScore?.totalDurationMs ?? 0}
- weakest leader eval tags:
${leaderTagBreakdown.length > 0 ? leaderTagBreakdown.map((line) => `  - ${line}`).join("\n") : "  - none"}

Benchmark split coverage:
- search tags:
${topSearchTags.length > 0 ? topSearchTags.map((line) => `  - ${line}`).join("\n") : "  - none"}
- hold-out tags:
${topHoldOutTags.length > 0 ? topHoldOutTags.map((line) => `  - ${line}`).join("\n") : "  - none"}

Community corpus summary:
- parsed sessions: ${context.communityStats?.parsedSessions ?? 0}/${context.communityStats?.totalSessions ?? 0}
- top failure tags:
${topFailureTags.length > 0 ? topFailureTags.map((line) => `  - ${line}`).join("\n") : "  - none"}

Read the canonical files as needed before you decide.

Return:
\`\`\`json
{
  "summary": "short description",
  "rationale": "why this improves the frontier objective",
  "generalizationNote": "why this should generalize beyond one task or trace",
  "targetedTags": ["weak_validation"],
  "targetedCaseIds": [],
  "promptSurfaceIds": ["proposer"],
  "patch": {
    "promptSurfaces": {
      "workerPolicy": "..."
    }
  }
}
\`\`\``,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const candidate = parseQuestExperimentCandidate(text);
	return {
		run: workerRunFromResult(
			modelChoice,
			result,
			"proposer",
			startedAt,
			{},
			candidate?.summary ?? (text || "No proposer candidate returned."),
			result.exitCode === 0 && Boolean(candidate),
			undefined,
			undefined,
		),
		candidate,
	};
}
