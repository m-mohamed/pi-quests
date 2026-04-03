import assert from "node:assert/strict";
import test from "node:test";
import {
	chooseHeuristicCandidate,
	defaultQuestProfile,
	evaluateQuestDataset,
	seedQuestDatasets,
	traceBundleFromWorkerRun,
} from "../src/trials-core.js";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function sampleQuest(cwd = "/tmp/pi-quests-trials") {
	return {
		id: "quest-trials",
		projectId: "quest-trials-project",
		cwd,
		title: "Trials",
		goal: "Improve Quest with evals and traces.",
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
			worker: DEFAULT_MODEL,
			validator: DEFAULT_MODEL,
		},
		plan: {
			title: "Trials",
			summary: "Improve Quest with evals and traces.",
			risks: [],
			environment: [],
			services: [],
			humanQaChecklist: ["Run human QA before shipping."],
			milestones: [
				{
					id: "m1",
					order: 1,
					title: "Improve harness",
					description: "Improve harness behavior from traces.",
					successCriteria: ["Harness quality improves."],
					status: "pending",
				},
			],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Handle prerequisites",
					description: "Detect prerequisites and context pressure.",
					preconditions: ["Start Docker before browser validation."],
					fulfills: ["Validation stays honest and bounded."],
					status: "pending",
				},
			],
		},
		validationReadiness: {
			summary: "Repo checks supported. Browser validation limited.",
			checks: [],
		},
		validationState: {
			assertions: [],
			updatedAt: Date.now(),
		},
		planRevisions: [],
		pendingPlanRevisionRequests: [],
		steeringNotes: [],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
}

test("defaultQuestProfile keeps the high-confidence Trials defaults", () => {
	const profile = defaultQuestProfile("project-123");
	assert.equal(profile.modelPolicy.preferSameModelFamily, true);
	assert.equal(profile.contextPolicy.spillLongOutputsToReports, true);
	assert.match(profile.promptSurfaces.planningPolicy, /limited or unsupported/i);
	assert.match(profile.promptSurfaces.workerPolicy, /Confirm prerequisites/i);
});

test("traceBundleFromWorkerRun derives failure tags from worker traces", () => {
	const quest = sampleQuest();
	const profile = defaultQuestProfile(quest.projectId);
	const run = {
		id: "run-1",
		role: "worker",
		featureId: "f1",
		milestoneId: "m1",
		startedAt: Date.now() - 5_000,
		endedAt: Date.now(),
		provider: DEFAULT_MODEL.provider,
		model: DEFAULT_MODEL.model,
		thinkingLevel: DEFAULT_MODEL.thinkingLevel,
		exitCode: 1,
		ok: false,
		summary: "Docker was not started before browser validation and the run hit a context overflow.",
		stderr: "docker compose up required before validation; context overflow",
		issues: ["Start Docker before validation."],
		phase: "streaming",
		events: [
			{
				ts: Date.now() - 4_000,
				type: "tool_execution_start",
				phase: "streaming",
				toolName: "bash",
				summary: "docker compose up",
			},
		],
	};

	const trace = traceBundleFromWorkerRun(quest, run, profile);
	assert.equal(trace.promptSurfaceId, "feature-worker");
	assert.equal(trace.role, "worker");
	assert.equal(trace.kind, "feature");
	assert.ok(trace.tags.includes("prerequisite_miss"));
	assert.ok(trace.tags.includes("context_overflow"));
	assert.ok(trace.tags.includes("worker_failure"));
	assert.ok(trace.derivedIssues.some((issue) => /Prerequisites were missing/i.test(issue)));
});

test("seeded datasets and heuristic candidates turn traces into targeted improvements", () => {
	const quest = sampleQuest();
	const profile = defaultQuestProfile(quest.projectId);
	const run = {
		id: "run-2",
		role: "worker",
		featureId: "f1",
		milestoneId: "m1",
		startedAt: Date.now() - 10_000,
		endedAt: Date.now(),
		provider: DEFAULT_MODEL.provider,
		model: DEFAULT_MODEL.model,
		thinkingLevel: DEFAULT_MODEL.thinkingLevel,
		exitCode: 1,
		ok: false,
		summary: "Long inline evidence caused a context overflow while collecting proof for the feature.",
		stderr: "context overflow while streaming evidence",
		phase: "streaming",
		events: [],
	};
	const trace = traceBundleFromWorkerRun(quest, run, profile);
	const datasets = seedQuestDatasets(quest.projectId, [trace]);
	const coreDataset = datasets.find((dataset) => dataset.kind === "core-regression");
	const replayDataset = datasets.find((dataset) => dataset.kind === "trace-replays");
	assert.ok(coreDataset);
	assert.ok(replayDataset);
	assert.ok(replayDataset.cases.some((testCase) => testCase.failureTags.includes("context_overflow")));

	const baseline = evaluateQuestDataset(profile, coreDataset);
	assert.equal(baseline.failed, 0);

	const candidate = chooseHeuristicCandidate(profile, [trace], datasets);
	assert.ok(candidate);
	assert.ok(candidate.targetedTags.includes("context_overflow"));
	assert.ok(candidate.promptSurfaceIds.includes("feature-worker"));
	assert.match(candidate.patch.promptSurfaces.workerPolicy, /Spill very long evidence/i);
});
