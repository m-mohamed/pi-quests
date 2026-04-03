import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultQuestProfile, traceBundleFromWorkerRun } from "../src/trials-core.js";
import { loadQuestTrialsSnapshot, replayQuestRunIntoTrialDataset } from "../src/trials-runtime.js";
import { listQuestTraceBundles, writeQuestTraceBundle } from "../src/state.js";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function sampleQuest(cwd) {
	return {
		id: "quest-runtime",
		projectId: "quest-runtime-project",
		cwd,
		title: "Quest Runtime",
		goal: "Replay traces into offline datasets.",
		status: "running",
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
			title: "Quest Runtime",
			summary: "Replay traces into offline datasets.",
			risks: [],
			environment: [],
			services: [],
			humanQaChecklist: ["Run human QA before shipping."],
			milestones: [
				{
					id: "m1",
					order: 1,
					title: "Replay traces",
					description: "Replay traces into dataset cases.",
					successCriteria: ["Interesting traces become offline cases."],
					status: "running",
				},
			],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Replay traces",
					description: "Replay traces into dataset cases.",
					preconditions: [],
					fulfills: ["Interesting traces become offline cases."],
					status: "running",
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

test("loadQuestTrialsSnapshot seeds repo-local trials artifacts and replayQuestRunIntoTrialDataset materializes cases", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-trials-runtime-"));
	try {
		const snapshot = await loadQuestTrialsSnapshot(repoDir, true);
		assert.equal(snapshot.state.status, "idle");
		assert.ok(existsSync(join(repoDir, ".pi", "quests", "trials", "state.json")));
		assert.ok(snapshot.datasets.some((dataset) => dataset.kind === "core-regression"));
		assert.ok(snapshot.datasets.some((dataset) => dataset.kind === "trace-replays"));

		const quest = sampleQuest(repoDir);
		const profile = defaultQuestProfile(quest.projectId);
		const trace = traceBundleFromWorkerRun(
			quest,
			{
				id: "run-replay",
				role: "validator",
				featureId: "f1",
				milestoneId: "m1",
				startedAt: Date.now() - 5_000,
				endedAt: Date.now(),
				provider: DEFAULT_MODEL.provider,
				model: DEFAULT_MODEL.model,
				thinkingLevel: DEFAULT_MODEL.thinkingLevel,
				exitCode: 1,
				ok: false,
				summary: "Validation stayed limited because browser coverage is manual and the milestone blocked.",
				stderr: "manual browser validation only",
				issues: ["Browser validation still requires human QA."],
				phase: "user_surface",
				events: [],
			},
			profile,
		);

		await writeQuestTraceBundle(repoDir, trace);
		const traces = await listQuestTraceBundles(repoDir);
		assert.equal(traces.length, 1);

		const replayDataset = await replayQuestRunIntoTrialDataset(repoDir, "run-replay");
		assert.ok(replayDataset);
		assert.ok(replayDataset.cases.length > 0);
		assert.ok(replayDataset.cases.some((testCase) => testCase.provenance.runId === "run-replay"));
		assert.ok(replayDataset.cases.some((testCase) => testCase.failureTags.includes("weak_validation")));
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});
