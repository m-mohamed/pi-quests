import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyQuestProfilePatch,
	candidateWins,
	chooseHeuristicCandidate,
	defaultQuestProfile,
	evaluateQuestDataset,
	seedQuestDatasets,
	traceBundleFromWorkerRun,
} from "./trials-core.js";
import { parseQuestPlanText, planningInstructions, revisionInstructions, synthesizeValidationAssertions } from "./plan-core.js";
import { markQuestAborted, prepareQuestForResume } from "./runtime-core.js";
import { loadActiveQuest, loadLearnedWorkflows, projectIdFor, saveLearnedWorkflows } from "./state-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import type {
	LearnedWorkflow,
	ModelChoice,
	QuestFeature,
	QuestMilestone,
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

export type EvalSuiteId = "regression" | "capability" | "offline-core";

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

async function withSandbox<T>(fn: (paths: { repoDir: string }) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-quests-evals-"));
	const repoDir = join(root, "repo");
	await mkdir(repoDir, { recursive: true });
	try {
		return await fn({ repoDir });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function sampleMilestones(): QuestMilestone[] {
	return [
		{
			id: "m1",
			order: 1,
			title: "Walking skeleton",
			description: "Boot the app and render the shell.",
			successCriteria: ["The shell renders cleanly."],
			status: "completed",
		},
		{
			id: "m2",
			order: 2,
			title: "Validation-first loop",
			description: "Persist validation state and keep human QA explicit.",
			successCriteria: ["Quest validation stays explicit and bounded."],
			validationPrompt: "Prefer repo checks first, then read-only validation.",
			status: "pending",
		},
	];
}

function sampleFeatures(): QuestFeature[] {
	return [
		{
			id: "f1",
			order: 1,
			milestoneId: "m1",
			title: "Render shell",
			description: "Render the initial quest shell.",
			preconditions: [],
			fulfills: ["The shell renders in the browser."],
			status: "completed",
			lastRunSummary: "Rendered the shell.",
			acceptanceCriteria: ["The shell renders in the browser."],
		},
		{
			id: "f2",
			order: 2,
			milestoneId: "m2",
			title: "Persist validation state",
			description: "Store validation state in repo-local quest artifacts.",
			preconditions: ["Confirm repo-local .pi/quests storage is available."],
			fulfills: ["Validation state persists under .pi/quests.", "Human QA remains explicit before shipping."],
			status: "pending",
			workerPrompt: "Keep state repo-local and avoid auto-shipping.",
			acceptanceCriteria: ["Validation state persists under .pi/quests.", "Human QA remains explicit before shipping."],
		},
	];
}

function samplePlan(): QuestPlan {
	return {
		title: "Arrow",
		summary: "Build a validation-first tracker.",
		goal: "Ship a validation-first tracker MVP.",
		risks: ["User-surface validation is limited locally."],
		environment: ["Use repo-local .pi/quests storage."],
		services: [
			{
				name: "web",
				purpose: "Quest control shell",
				commands: ["npm run dev"],
				ports: [3000],
			},
		],
		validationSummary: "Repo checks are strong. Visual polish still needs human QA.",
		humanQaChecklist: ["Run through the quest flow manually before shipping."],
		milestones: sampleMilestones(),
		features: sampleFeatures(),
	};
}

function sampleQuest(cwd = "/tmp/arrow"): QuestState {
	const plan = samplePlan();
	return {
		id: "quest-eval",
		projectId: projectIdFor(cwd),
		cwd,
		title: plan.title,
		goal: "Ship a validation-first tracker MVP.",
		status: "proposal_ready",
		config: {
			orchestratorModel: DEFAULT_MODEL,
			workerModel: DEFAULT_MODEL,
			validatorModel: DEFAULT_MODEL,
			validationConcurrency: 2,
			cwd,
			createdAt: Date.now(),
		},
		defaultModel: DEFAULT_MODEL,
		roleModels: {
			orchestrator: DEFAULT_MODEL,
			worker: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validator: DEFAULT_MODEL,
		},
		plan,
		planHash: "eval-hash",
		validationReadiness: {
			summary: "Repo checks supported, browser validation limited.",
			checks: [
				{ id: "checks", surface: "repo-checks", description: "npm run check", status: "supported", commands: ["npm run check"], evidence: ["package scripts present"] },
				{ id: "browser", surface: "browser", description: "Visual shell checks", status: "limited", commands: [], evidence: ["No browser harness in eval env"], notes: "Human QA still required." },
			],
		},
		validationState: {
			assertions: synthesizeValidationAssertions(plan.milestones, plan.features),
			updatedAt: Date.now(),
		},
		planRevisions: [],
		pendingPlanRevisionRequests: [],
		steeringNotes: ["Keep the quest serial by default."],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
}

function sampleRunningQuest(cwd = "/tmp/arrow"): QuestState {
	const quest = sampleQuest(cwd);
	quest.status = "running";
	quest.plan!.milestones[1]!.status = "running";
	quest.plan!.features[1]!.status = "running";
	quest.activeRun = {
		role: "worker",
		kind: "feature",
		featureId: "f2",
		milestoneId: "m2",
		phase: "streaming",
		startedAt: Date.now() - 1000,
		pid: process.pid,
	};
	return quest;
}

function sampleWorkflows(): LearnedWorkflow[] {
	return [
		{
			id: "workflow-1",
			title: "Run database setup before app validation",
			note: "Quest validation depends on database setup completing first.",
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
		id: "abort-state-transition",
		title: "Operator abort blocks only the active work and preserves resumability",
		suite: "regression",
		run: async () => {
			const quest = sampleRunningQuest();
			const summary = markQuestAborted(quest, 123456);
			const passed =
				quest.status === "aborted" &&
				quest.plan?.features.find((feature) => feature.id === "f2")?.status === "blocked" &&
				quest.plan?.features.find((feature) => feature.id === "f1")?.status === "completed" &&
				quest.lastInterruption?.interruptedAt === 123456;
			return result("regression", "abort-state-transition", "Operator abort blocks only the active work and preserves resumability", passed, passed ? "Abort preserved completed work and blocked only the interrupted feature." : "Abort state transition regressed.", { summary, status: quest.status });
		},
	},
	{
		id: "resume-after-abort",
		title: "Resume reopens only the interrupted unfinished work",
		suite: "regression",
		run: async () => {
			const quest = sampleRunningQuest();
			markQuestAborted(quest, 123456);
			const changed = prepareQuestForResume(quest);
			const passed =
				changed &&
				quest.status === "paused" &&
				quest.plan?.features.find((feature) => feature.id === "f2")?.status === "pending" &&
				quest.plan?.features.find((feature) => feature.id === "f1")?.status === "completed" &&
				quest.activeRun === undefined;
			return result("regression", "resume-after-abort", "Resume reopens only the interrupted unfinished work", passed, passed ? "Resume preserved completed work and reopened only the interrupted feature." : "Resume-after-abort behavior regressed.", { changed, status: quest.status });
		},
	},
	{
		id: "telemetry-tracks-progress",
		title: "Captures message and tool progress in live telemetry snapshots",
		suite: "regression",
		run: async () => {
			let snapshot = createLiveRunSnapshot("worker", { featureId: "f2", milestoneId: "m2" });
			let events: ReturnType<typeof applyAgentEventToSnapshot>["events"] = [];
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Planning the feature" } }, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm run check" } }, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "npm run check" }, partialResult: { content: [{ type: "text", text: "1 passed" }] } }, 60, events));
			({ snapshot, events } = applyAgentEventToSnapshot(snapshot, { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "1 passed" }] }, isError: false }, 60, events));
			const passed = snapshot.phase === "streaming" && snapshot.latestToolName === "bash" && Boolean(snapshot.latestToolSummary?.includes("1 passed")) && events.length === 4;
			return result("regression", "telemetry-tracks-progress", "Captures message and tool progress in live telemetry snapshots", passed, passed ? "Telemetry captured streaming text and tool execution progress." : "Telemetry did not retain the expected live snapshot state.", { phase: snapshot.phase, latestToolName: snapshot.latestToolName });
		},
	},
	{
		id: "passive-read-stays-read-only",
		title: "Passive quest reads do not create quest storage",
		suite: "regression",
		run: async () => {
			return withSandbox(async ({ repoDir }) => {
				const loaded = await loadActiveQuest(repoDir);
				const passed = loaded === null && !existsSync(join(repoDir, ".pi", "quests"));
				return result("regression", "passive-read-stays-read-only", "Passive quest reads do not create quest storage", passed, passed ? "Quest status-style reads stayed passive." : "Passive reads created quest storage.", { loadedQuest: loaded, questRootExists: existsSync(join(repoDir, ".pi", "quests")) });
			});
		},
	},
	{
		id: "learned-workflows-stay-private",
		title: "Learned workflows persist under repo-local quest state",
		suite: "regression",
		run: async () => {
			return withSandbox(async ({ repoDir }) => {
				const workflows = sampleWorkflows();
				await saveLearnedWorkflows(repoDir, workflows);
				const reloaded = await loadLearnedWorkflows(repoDir);
				const workflowFile = join(repoDir, ".pi", "quests", "shared-skills", "index.json");
				const passed = reloaded.length === 1 && existsSync(workflowFile);
				return result("regression", "learned-workflows-stay-private", "Learned workflows persist under repo-local quest state", passed, passed ? "Learned workflows persisted under repo-local quest state." : "Learned workflows failed to persist in repo-local quest state.", { workflowFile, reloadedCount: reloaded.length });
			});
		},
	},
	{
		id: "planning-prompt-is-profile-driven",
		title: "Planning prompt stays proposal-first and profile-driven",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const prompt = planningInstructions(quest, sampleWorkflows(), profile);
			const passed =
				prompt.includes("quest_set_proposal") &&
				prompt.includes("Profile surface policy:") &&
				prompt.includes("limited or unsupported") &&
				prompt.includes("Build the smallest viable implementation first");
			return result("capability", "planning-prompt-is-profile-driven", "Planning prompt stays proposal-first and profile-driven", passed, passed ? "Planning prompt includes structured quest tools and profile policy." : "Planning prompt lost structured-tool or profile-policy guidance.", { snippet: prompt.slice(0, 320) });
		},
	},
	{
		id: "revision-prompt-limits-scope",
		title: "Revision prompt confines replanning to unfinished work",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const prompt = revisionInstructions(quest, sampleRevisionRequests(), sampleWorkflows(), profile);
			const systemPrompt = buildPlanRevisionSystemPrompt(profile);
			const passed =
				prompt.includes("Preserve completed milestones and completed features.") &&
				prompt.includes("Profile surface policy:") &&
				systemPrompt.includes("Preserve completed work.") &&
				systemPrompt.includes("Policy surface:");
			return result("capability", "revision-prompt-limits-scope", "Revision prompt confines replanning to unfinished work", passed, passed ? "Revision prompts preserve completed work and expose the mutable policy surface." : "Revision prompts are missing the remaining-work boundary or profile surface.", { requestCount: sampleRevisionRequests().length });
		},
	},
	{
		id: "worker-prompt-stays-single-feature",
		title: "Worker prompt stays scoped to one feature and profile policy",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const milestone = quest.plan!.milestones[1]!;
			const feature = quest.plan!.features[1]!;
			const prompt = buildFeaturePrompt(quest, feature, milestone, sampleWorkflows(), profile);
			const systemPrompt = buildWorkerSystemPrompt(profile);
			const passed =
				prompt.includes("Assigned feature: Persist validation state") &&
				prompt.includes("Profile surface policy:") &&
				prompt.includes("Confirm prerequisites") &&
				systemPrompt.includes("Budget:");
			return result("capability", "worker-prompt-stays-single-feature", "Worker prompt stays scoped to one feature and profile policy", passed, passed ? "Worker prompt stays single-feature and profile-aware." : "Worker prompt scope or profile guidance regressed.", { featureTitle: feature.title });
		},
	},
	{
		id: "validator-prompt-is-read-only",
		title: "Validator prompt is read-only and explicit about weak validation",
		suite: "capability",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const milestone = quest.plan!.milestones[1]!;
			const features = quest.plan!.features.filter((feature) => feature.milestoneId === milestone.id);
			const prompt = buildValidatorPrompt(quest, milestone, features, sampleWorkflows(), "code_review", profile);
			const systemPrompt = buildValidatorSystemPrompt("code_review", profile);
			const passed =
				prompt.includes("You are read-only. Verify the milestone. Do not edit code.") &&
				prompt.includes("Profile surface policy:") &&
				systemPrompt.includes("Do not edit or write files.") &&
				systemPrompt.includes("Budget:");
			return result("capability", "validator-prompt-is-read-only", "Validator prompt is read-only and explicit about weak validation", passed, passed ? "Validator prompt keeps validation read-only and profile-aware." : "Validator prompt lost read-only or profile guidance.", { featureCount: features.length });
		},
	},
	{
		id: "offline-core-default-profile",
		title: "Default Quest profile passes seeded offline-core datasets",
		suite: "offline-core",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const datasets = seedQuestDatasets(quest.projectId, []);
			const scores = datasets
				.filter((dataset) => dataset.kind === "core-regression" || dataset.kind === "held-out")
				.map((dataset) => evaluateQuestDataset(profile, dataset));
			const passed = scores.every((score) => score.failed === 0);
			return result("offline-core", "offline-core-default-profile", "Default Quest profile passes seeded offline-core datasets", passed, passed ? "Default profile passes the seeded core and held-out datasets." : "Default profile failed one or more seeded offline-core cases.", { scores });
		},
	},
	{
		id: "offline-core-trace-replay-materialization",
		title: "Interesting traces become replayable offline cases",
		suite: "offline-core",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const failingRun = {
				id: "run-1",
				role: "worker" as const,
				featureId: "f2",
				milestoneId: "m2",
				startedAt: Date.now() - 10_000,
				endedAt: Date.now(),
				provider: "openai-codex",
				model: "gpt-5.4-mini",
				thinkingLevel: "high" as const,
				exitCode: 1,
				ok: false,
				summary: "Docker was not running before browser validation and the run hit a context overflow.",
				stderr: "docker not found; context length exceeded",
				issues: ["Start Docker before validation"],
				phase: "streaming",
				latestToolName: "bash",
				latestToolSummary: "docker compose up",
				latestAssistantText: "Need to start Docker first.",
				events: [],
			};
			const trace = traceBundleFromWorkerRun(quest, failingRun, profile);
			const datasets = seedQuestDatasets(quest.projectId, [trace]);
			const replay = datasets.find((dataset) => dataset.kind === "trace-replays");
			const passed = Boolean(replay && replay.cases.length > 0 && replay.cases.some((testCase) => testCase.failureTags.includes("prerequisite_miss")));
			return result("offline-core", "offline-core-trace-replay-materialization", "Interesting traces become replayable offline cases", passed, passed ? "Trace replay dataset materialized offline cases from an interesting trace." : "Trace replay materialization did not produce the expected replay cases.", { traceTags: trace.tags, replayCaseCount: replay?.cases.length ?? 0 });
		},
	},
	{
		id: "offline-core-heuristic-candidate-wins-spotcheck",
		title: "Heuristic Trials candidates must win their targeted spot checks",
		suite: "offline-core",
		run: async () => {
			const quest = sampleQuest();
			const profile = defaultQuestProfile(quest.projectId);
			const trace = traceBundleFromWorkerRun(
				quest,
				{
					id: "run-2",
					role: "worker",
					featureId: "f2",
					milestoneId: "m2",
					startedAt: Date.now() - 10_000,
					endedAt: Date.now(),
					provider: "openai-codex",
					model: "gpt-5.4-mini",
					thinkingLevel: "high",
					exitCode: 1,
					ok: false,
					summary: "Long evidence caused a context overflow before validation completed.",
					stderr: "context overflow",
					phase: "streaming",
					events: [],
				},
				profile,
			);
			const datasets = seedQuestDatasets(quest.projectId, [trace]);
			const candidate = chooseHeuristicCandidate(profile, [trace], datasets);
			const passed = Boolean(candidate);
			if (!candidate) {
				return result("offline-core", "offline-core-heuristic-candidate-wins-spotcheck", "Heuristic Trials candidates must win their targeted spot checks", false, "Trials could not derive a heuristic candidate from an interesting trace.");
			}
			const candidateProfile = applyQuestProfilePatch(profile, candidate.patch);
			const replayDataset = datasets.find((dataset) => dataset.kind === "trace-replays")!;
			const baselineScores = [evaluateQuestDataset(profile, replayDataset, candidate.targetedCaseIds.length > 0 ? candidate.targetedCaseIds : undefined)];
			const candidateScores = [evaluateQuestDataset(candidateProfile, replayDataset, candidate.targetedCaseIds.length > 0 ? candidate.targetedCaseIds : undefined)];
			return result("offline-core", "offline-core-heuristic-candidate-wins-spotcheck", "Heuristic Trials candidates must win their targeted spot checks", passed && candidateWins(baselineScores, candidateScores), candidateWins(baselineScores, candidateScores) ? "Heuristic candidate improved its targeted replay cases." : "Heuristic candidate did not improve its targeted replay cases.", {
				candidate: candidate.summary,
				baselineScores,
				candidateScores,
			});
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
	return ["regression", "capability", "offline-core"];
}
