import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuestPlanText, planningInstructions, revisionInstructions, synthesizeValidationContract } from "./plan-core.js";
import { loadActiveQuest, loadLearnedWorkflows, projectIdFor, saveLearnedWorkflows } from "./state-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import type {
	LearnedWorkflow,
	ModelChoice,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestState,
} from "./types.js";
import {
	buildFeaturePrompt,
	buildPlanRevisionSystemPrompt,
	buildValidatorPrompt,
	buildValidatorSystemPrompt,
	buildWorkerSystemPrompt,
} from "./workers.js";

export type EvalSuiteId = "regression" | "capability";

export interface EvalCaseResult {
	id: string;
	title: string;
	suite: EvalSuiteId;
	passed: boolean;
	score: number;
	maxScore: number;
	summary: string;
	artifacts?: Record<string, unknown>;
}

export interface EvalSuiteResult {
	suite: EvalSuiteId;
	passed: number;
	failed: number;
	score: number;
	maxScore: number;
	results: EvalCaseResult[];
}

interface EvalCaseDefinition {
	id: string;
	title: string;
	suite: EvalSuiteId;
	run: () => Promise<EvalCaseResult>;
}

const DEFAULT_MODEL: ModelChoice = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function result(
	suite: EvalSuiteId,
	id: string,
	title: string,
	passed: boolean,
	summary: string,
	artifacts?: Record<string, unknown>,
): EvalCaseResult {
	return {
		id,
		title,
		suite,
		passed,
		score: passed ? 1 : 0,
		maxScore: 1,
		summary,
		artifacts,
	};
}

async function withSandbox<T>(fn: (paths: { agentDir: string; repoDir: string }) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-quests-evals-"));
	const agentDir = join(root, "agent");
	const repoDir = join(root, "repo");
	await mkdir(agentDir, { recursive: true });
	await mkdir(repoDir, { recursive: true });
	try {
		return await fn({ agentDir, repoDir });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function samplePlan(): QuestPlan {
	return {
		title: "Arrow",
		summary: "Build a validated project-management MVP",
		successCriteria: ["Ship a validated MVP without auto-shipping to production."],
		milestones: [
			{
				id: "m1",
				title: "Walking skeleton",
				summary: "Boot the app and render the shell",
				successCriteria: ["The app boots cleanly and the shell renders."],
				status: "completed",
			},
			{
				id: "m2",
				title: "Validation-first workflow",
				summary: "Add quest validation and human QA gates",
				successCriteria: ["Validation passes and QA remains explicit."],
				validationPrompt: "Prefer command checks first, then browser verification.",
				status: "pending",
			},
		],
		features: [
			{
				id: "f1",
				title: "Render shell",
				summary: "Render the app shell",
				milestoneId: "m1",
				acceptanceCriteria: ["The page renders in the browser"],
				status: "completed",
				lastRunSummary: "Rendered the shell",
			},
			{
				id: "f2",
				title: "Persist validation contract",
				summary: "Store the validation contract in quest state",
				milestoneId: "m2",
				acceptanceCriteria: [
					"The repo test command passes",
					"Inspect the quest state file and confirm the contract was persisted",
				],
				workerPrompt: "Keep the state private under ~/.pi/agent/quests.",
				status: "pending",
			},
			{
				id: "f3",
				title: "Require human QA approval",
				summary: "Require explicit approval after validation",
				milestoneId: "m2",
				acceptanceCriteria: ["Human QA is still required before shipping"],
				status: "pending",
			},
		],
		validationContract: {
			summary: "Quest validation combines command, browser, and manual proof paths.",
			milestoneExpectations: [
				{
					milestoneId: "m1",
					title: "Walking skeleton",
					expectedBehaviors: ["The shell renders cleanly."],
				},
				{
					milestoneId: "m2",
					title: "Validation-first workflow",
					expectedBehaviors: ["Validation state is persisted and QA remains explicit."],
				},
			],
			featureChecks: [
				{ featureId: "f1", title: "Render shell", criterionIds: ["criterion-1"] },
				{ featureId: "f2", title: "Persist validation contract", criterionIds: ["criterion-2", "criterion-3"] },
				{ featureId: "f3", title: "Require human QA approval", criterionIds: ["criterion-4"] },
			],
			criteria: [
				{
					id: "criterion-1",
					title: "Shell renders",
					milestoneId: "m1",
					featureIds: ["f1"],
					expectedBehavior: "The shell renders in the browser",
					proofStrategy: "browser",
					proofDetails: "Load the page and confirm the shell is visible.",
					commands: [],
					confidence: "high",
				},
				{
					id: "criterion-2",
					title: "Tests pass",
					milestoneId: "m2",
					featureIds: ["f2"],
					expectedBehavior: "The repo test command passes",
					proofStrategy: "command",
					proofDetails: "Run the repo's canonical test command.",
					commands: ["bun test"],
					confidence: "high",
				},
				{
					id: "criterion-3",
					title: "Quest state persisted",
					milestoneId: "m2",
					featureIds: ["f2"],
					expectedBehavior: "Inspect the quest state file and confirm the contract was persisted",
					proofStrategy: "read_only",
					proofDetails: "Read quest.json and confirm the validation contract exists.",
					commands: [],
					confidence: "medium",
				},
				{
					id: "criterion-4",
					title: "QA remains explicit",
					milestoneId: "m2",
					featureIds: ["f3"],
					expectedBehavior: "Human QA is still required before shipping",
					proofStrategy: "manual",
					proofDetails: "A human must inspect the final result before approving the quest.",
					commands: [],
					confidence: "low",
				},
			],
			weakValidationWarnings: ["Final visual polish still depends on human QA."],
		},
	};
}

function sampleQuest(cwd = "/tmp/arrow"): QuestState {
	return {
		id: "quest-eval",
		projectId: projectIdFor(cwd),
		cwd,
		title: "Arrow",
		goal: "Ship a validation-first project-management MVP.",
		status: "ready",
		defaultModel: DEFAULT_MODEL,
		roleModels: {
			worker: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validator: { provider: "opencode-go", model: "glm-5", thinkingLevel: "high" },
		},
		plan: samplePlan(),
		planHash: "eval-hash",
		planRevisions: [],
		pendingPlanRevisionRequests: [],
		steeringNotes: ["Keep the quest serial by default.", "Do not auto-ship after validation."],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
}

function sampleWorkflows(): LearnedWorkflow[] {
	return [
		{
			id: "workflow-1",
			title: "Run database setup before app validation",
			note: "Quest validation depends on the app database being initialized first.",
			source: "validator_failure",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			evidence: ["Validator failed before the seed step completed."],
		},
	];
}

function sampleRevisionRequests(): QuestPlanRevisionRequest[] {
	return [
		{
			id: "request-1",
			source: "steer",
			note: "Split validation persistence from the human QA gate.",
			createdAt: Date.now(),
			milestoneId: "m2",
		},
	];
}

const evalCases: EvalCaseDefinition[] = [
	{
		id: "validation-contract-synthesis",
		title: "Synthesizes explicit validation contracts with weak-path warnings",
		suite: "regression",
		run: async () => {
			const contract = synthesizeValidationContract(
				[
					{
						id: "m1",
						title: "Walking skeleton",
						summary: "Boot the app",
						successCriteria: ["The app boots and renders"],
						status: "pending",
					},
				],
				[
					{
						id: "f1",
						title: "Render shell",
						summary: "Render the shell",
						milestoneId: "m1",
						acceptanceCriteria: [
							"The page renders in the browser",
							"The repo test command passes",
							"Inspect the generated config file",
							"Human QA signs off on the final polish",
						],
						status: "pending",
					},
				],
				["The app is usable"],
			);
			const strategies = contract.criteria.map((criterion) => criterion.proofStrategy);
			const passed =
				strategies.includes("browser") &&
				strategies.includes("command") &&
				strategies.includes("read_only") &&
				strategies.includes("manual") &&
				contract.weakValidationWarnings.length >= 2;
			return result("regression", "validation-contract-synthesis", "Synthesizes explicit validation contracts with weak-path warnings", passed, passed ? "Validation synthesis covers browser, command, read-only, and manual proof paths." : "Validation synthesis is missing proof-path coverage or weak-validation warnings.", {
				strategies,
				weakValidationWarnings: contract.weakValidationWarnings,
			});
		},
	},
	{
		id: "explicit-contract-parsing",
		title: "Preserves explicit validation contract metadata from quest proposals",
		suite: "regression",
		run: async () => {
			const parsed = parseQuestPlanText(`
\`\`\`json
${JSON.stringify(samplePlan(), null, 2)}
\`\`\`
`);
			const passed =
				Boolean(parsed) &&
				parsed?.plan.validationContract.summary === samplePlan().validationContract.summary &&
				parsed?.plan.validationContract.criteria[1]?.commands[0] === "bun test" &&
				parsed?.plan.validationContract.weakValidationWarnings[0] === "Final visual polish still depends on human QA.";
			return result(
				"regression",
				"explicit-contract-parsing",
				"Preserves explicit validation contract metadata from quest proposals",
				passed,
				passed ? "Quest proposal parsing preserved the explicit contract structure." : "Quest proposal parsing lost explicit contract metadata.",
				{
					criteria: parsed?.plan.validationContract.criteria.length ?? 0,
					warnings: parsed?.plan.validationContract.weakValidationWarnings ?? [],
				},
			);
		},
	},
	{
		id: "telemetry-tracks-progress",
		title: "Captures message and tool progress in live telemetry snapshots",
		suite: "regression",
		run: async () => {
			let snapshot = createLiveRunSnapshot("worker", { featureId: "f2", milestoneId: "m2" });
			let events: ReturnType<typeof applyAgentEventToSnapshot>["events"] = [];

			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Planning the feature" },
			}, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, {
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "bun test" },
			}, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, {
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "bun test" },
				partialResult: { content: [{ type: "text", text: "1 passed" }] },
			}, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "1 passed" }] },
				isError: false,
			}, 60, events));

			const passed =
				snapshot.phase === "streaming" &&
				snapshot.latestToolName === "bash" &&
				snapshot.latestToolSummary?.includes("1 passed") &&
				events.length === 4;
			return result(
				"regression",
				"telemetry-tracks-progress",
				"Captures message and tool progress in live telemetry snapshots",
				passed,
				passed ? "Telemetry captured streaming text and tool execution progress." : "Telemetry did not retain the expected live snapshot state.",
				{
					phase: snapshot.phase,
					latestToolName: snapshot.latestToolName,
					eventTypes: events.map((event) => event.type),
				},
			);
		},
	},
	{
		id: "passive-read-stays-read-only",
		title: "Passive quest reads do not create quest storage",
		suite: "regression",
		run: async () => {
			return withSandbox(async ({ agentDir, repoDir }) => {
				const loaded = await loadActiveQuest(agentDir, repoDir);
				const passed = loaded === null && !existsSync(join(agentDir, "quests"));
				return result(
					"regression",
					"passive-read-stays-read-only",
					"Passive quest reads do not create quest storage",
					passed,
					passed ? "Quest status-style reads stayed passive." : "Passive reads created quest storage.",
					{
						loadedQuest: loaded,
						questRootExists: existsSync(join(agentDir, "quests")),
					},
				);
			});
		},
	},
	{
		id: "learned-workflows-stay-private",
		title: "Learned workflows persist under private quest state, not repo state",
		suite: "regression",
		run: async () => {
			return withSandbox(async ({ agentDir, repoDir }) => {
				const workflows = sampleWorkflows();
				await saveLearnedWorkflows(agentDir, repoDir, workflows);
				const reloaded = await loadLearnedWorkflows(agentDir, repoDir);
				const workflowFile = join(agentDir, "quests", "projects", projectIdFor(repoDir), "workflows", "learned-workflows.json");
				const passed = reloaded.length === 1 && existsSync(workflowFile) && !existsSync(join(repoDir, "learned-workflows.json"));
				return result(
					"regression",
					"learned-workflows-stay-private",
					"Learned workflows persist under private quest state, not repo state",
					passed,
					passed ? "Learned workflows stayed private under ~/.pi/agent/quests-style storage." : "Learned workflows escaped into repo state or failed to persist.",
					{
						workflowFile,
						reloadedCount: reloaded.length,
					},
				);
			});
		},
	},
	{
		id: "planning-prompt-is-validation-first",
		title: "Planning prompt requires upfront proposal review and validation contracts",
		suite: "capability",
		run: async () => {
			const prompt = planningInstructions(sampleQuest(), sampleWorkflows());
			const passed =
				prompt.includes("Do not execute the plan yet.") &&
				prompt.includes("Build an explicit validation contract") &&
				prompt.includes("If validation is weak, say so explicitly") &&
				prompt.includes("When the plan is ready, end your response with a machine-readable JSON block.");
			return result(
				"capability",
				"planning-prompt-is-validation-first",
				"Planning prompt requires upfront proposal review and validation contracts",
				passed,
				passed ? "Planning prompt enforces proposal-first, validation-first quest setup." : "Planning prompt is missing one of the proposal or validation-first requirements.",
				{
					snippet: prompt.slice(0, 320),
				},
			);
		},
	},
	{
		id: "revision-prompt-limits-scope",
		title: "Revision prompt confines replanning to unfinished work",
		suite: "capability",
		run: async () => {
			const prompt = revisionInstructions(sampleQuest(), sampleRevisionRequests(), sampleWorkflows());
			const systemPrompt = buildPlanRevisionSystemPrompt();
			const passed =
				prompt.includes("Preserve completed milestones and completed features.") &&
				prompt.includes("You may change only unfinished work") &&
				prompt.includes("Keep the quest serial by default.") &&
				systemPrompt.includes("Preserve completed work.");
			return result(
				"capability",
				"revision-prompt-limits-scope",
				"Revision prompt confines replanning to unfinished work",
				passed,
				passed ? "Revision prompts preserve completed work and constrain remaining-plan edits." : "Revision prompts are missing a remaining-work boundary.",
				{
					requestCount: sampleRevisionRequests().length,
				},
			);
		},
	},
	{
		id: "worker-prompt-stays-single-feature",
		title: "Worker prompt stays scoped to one feature and its validation contract",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const milestone = quest.plan!.milestones[1]!;
			const feature = quest.plan!.features[1]!;
			const prompt = buildFeaturePrompt(quest, feature, milestone, sampleWorkflows());
			const systemPrompt = buildWorkerSystemPrompt();
			const passed =
				prompt.includes("Assigned feature: Persist validation contract") &&
				prompt.includes("Validation contract for this feature:") &&
				prompt.includes("Execute only this feature. Keep the quest serial and scoped.") &&
				systemPrompt.includes("Focus only on the assigned feature.") &&
				systemPrompt.includes("Respect the validation contract.");
			return result(
				"capability",
				"worker-prompt-stays-single-feature",
				"Worker prompt stays scoped to one feature and its validation contract",
				passed,
				passed ? "Worker prompt stays single-feature and validation-aware." : "Worker prompt scope or validation guidance regressed.",
				{
					featureTitle: feature.title,
				},
			);
		},
	},
	{
		id: "validator-prompt-is-read-only",
		title: "Validator prompt is read-only and surfaces weak validation areas",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const milestone = quest.plan!.milestones[1]!;
			const features = quest.plan!.features.filter((feature) => feature.milestoneId === milestone.id);
			const prompt = buildValidatorPrompt(quest, milestone, features, sampleWorkflows());
			const systemPrompt = buildValidatorSystemPrompt();
			const passed =
				prompt.includes("You are read-only. Verify the milestone by reading files and running checks. Do not edit code.") &&
				prompt.includes("Known weak validation areas:") &&
				prompt.includes("Final visual polish still depends on human QA.") &&
				systemPrompt.includes("Verify the assigned milestone using read-only tools and commands.") &&
				systemPrompt.includes("Do not edit or write files.");
			return result(
				"capability",
				"validator-prompt-is-read-only",
				"Validator prompt is read-only and surfaces weak validation areas",
				passed,
				passed ? "Validator prompt keeps verification read-only and explicit about weak validation." : "Validator prompt lost read-only or weak-validation guidance.",
				{
					featureCount: features.length,
				},
			);
		},
	},
];

export async function runEvalSuite(suite: EvalSuiteId): Promise<EvalSuiteResult> {
	const selected = evalCases.filter((evalCase) => evalCase.suite === suite);
	const results: EvalCaseResult[] = [];
	for (const evalCase of selected) {
		results.push(await evalCase.run());
	}
	const passed = results.filter((item) => item.passed).length;
	const score = results.reduce((total, item) => total + item.score, 0);
	const maxScore = results.reduce((total, item) => total + item.maxScore, 0);
	return {
		suite,
		passed,
		failed: results.length - passed,
		score,
		maxScore,
		results,
	};
}

export function availableEvalSuites(): EvalSuiteId[] {
	return ["regression", "capability"];
}
