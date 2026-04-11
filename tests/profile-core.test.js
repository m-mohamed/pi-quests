import assert from "node:assert/strict";
import test from "node:test";
import {
	defaultQuestProfile,
	traceBundleFromWorkerRun,
} from "../src/profile-core.js";

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

test("defaultQuestProfile stays Quest-native and benchmark-neutral", () => {
	const profile = defaultQuestProfile("project-123");
	assert.equal(profile.modelPolicy.preferSameModelFamily, true);
	assert.equal(profile.contextPolicy.spillLongOutputsToReports, true);
	assert.match(profile.promptSurfaces.planningPolicy, /clarifying questions/i);
	assert.match(profile.promptSurfaces.workerPolicy, /Confirm prerequisites/i);
	assert.doesNotMatch(profile.promptSurfaces.workerPolicy, /benchmark/i);
	assert.doesNotMatch(profile.promptSurfaces.proposerPolicy, /search-set mean score|behavioral tag cohorts|hold-out/i);
	assert.equal(profile.harnessPolicy.computationalGuides.enabled, true);
	assert.equal(profile.harnessPolicy.inferentialGuides.enabled, true);
	assert.equal(profile.harnessPolicy.sensors.inferential.enabled, true);
	assert.equal(profile.harnessPolicy.fitnessFunctions.enabled, true);
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
