import assert from "node:assert/strict";
import test from "node:test";
import { handleQuestEvalsCommand, openQuestEvalsControl } from "../src/quest-evals-controller.js";

function makeProfile(overrides = {}) {
	return {
		id: "repo-test",
		target: "repo",
		adoptedChanges: [],
		modelPolicy: {
			preferSameModelFamily: false,
			preferValidatorDivergence: false,
		},
		contextPolicy: {
			spillThresholdChars: 12000,
			spillLongOutputsToReports: true,
			maxInlineEvidenceLines: 24,
		},
		...overrides,
	};
}

function makeOptimizerState(status = "idle", overrides = {}) {
	return {
		projectId: "repo-project",
		target: "repo",
		activeProfileId: "repo-test",
		storageVersion: 4,
		frontierCandidateIds: [],
		status,
		updatedAt: Date.now(),
		...overrides,
	};
}

function createDeps(trials, options = {}) {
	let currentQuest = options.currentQuest ?? null;
	let currentOptimizerState = options.currentOptimizerState ?? makeOptimizerState();
	let currentProfile = options.currentProfile ?? makeProfile();
	let optimizerLiveRun = options.optimizerLiveRun ?? null;
	let activeOptimizerPid = options.activeOptimizerPid;
	const notes = [];
	let uiCalls = 0;

	return {
		notes,
		get currentOptimizerState() {
			return currentOptimizerState;
		},
		get optimizerLiveRun() {
			return optimizerLiveRun;
		},
		get uiCalls() {
			return uiCalls;
		},
		deps: {
			pi: {
				getThinkingLevel: () => "high",
			},
			ctx: {
				cwd: "/tmp/pi-quests-repo",
				hasUI: options.hasUI ?? false,
				ui: {
					custom: options.customUi ?? false,
				},
				model: null,
			},
			getCurrentQuest: () => currentQuest,
			getCurrentOptimizerState: () => currentOptimizerState,
			getCurrentProfile: () => currentProfile,
			getOptimizerLiveRun: () => optimizerLiveRun,
			getActiveOptimizerPid: () => activeOptimizerPid,
			setCurrentOptimizerState: (state) => {
				currentOptimizerState = state;
			},
			setCurrentProfile: (profile) => {
				currentProfile = profile;
			},
			setOptimizerLiveRun: (snapshot) => {
				optimizerLiveRun = snapshot;
			},
			setActiveOptimizerPid: (pid) => {
				activeOptimizerPid = pid;
			},
			emitNote: async (content) => {
				notes.push(content);
			},
			applyQuestUi: async () => {
				uiCalls += 1;
			},
			internalModeEnabled: true,
			loadFrontierOptimizer: async () => trials,
		},
	};
}

test("openQuestEvalsControl summarizes the live optimizer state instead of stale snapshots", async () => {
	const profile = makeProfile();
	const { deps, notes } = createDeps(
		{
			collectFrontierOptimizerStatus: async () => ({
				state: makeOptimizerState("idle"),
				profile,
			}),
			summarizeOptimizerStatus: () => "idle summary",
		},
		{
			optimizerLiveRun: {
				role: "optimizer",
				phase: "baseline-search",
				latestToolName: "bash",
				updatedAt: Date.now(),
			},
		},
	);

	await openQuestEvalsControl(deps);

	assert.equal(notes.length, 1);
	assert.match(notes[0], /idle summary/);
	assert.match(notes[0], /Active optimizer run:\s+idle/);
});

test("handleQuestEvalsCommand uses refreshed optimizer status instead of captured running state", async () => {
	let optimizationRuns = 0;
	const profile = makeProfile();
	const { deps, notes } = createDeps(
		{
			collectFrontierOptimizerStatus: async () => ({
				state: makeOptimizerState("idle"),
				profile,
			}),
			summarizeOptimizerStatus: () => "idle summary",
			runOptimizerOptimization: async () => {
				optimizationRuns += 1;
				return {
					state: makeOptimizerState("idle"),
					profile,
					summary: "optimization complete",
				};
			},
		},
		{
			currentOptimizerState: makeOptimizerState("running"),
		},
	);

	await handleQuestEvalsCommand("run", deps);

	assert.equal(optimizationRuns, 1);
	assert.equal(notes.includes("Evals are already running."), false);
	assert.ok(notes.some((note) => note.includes("optimization complete")));
});

test("handleQuestEvalsCommand refreshes the Quest UI after prepare", async () => {
	const profile = makeProfile();
	const harness = createDeps({
		collectFrontierOptimizerStatus: async () => ({
			state: makeOptimizerState("idle"),
			profile,
		}),
		summarizeOptimizerStatus: () => "idle summary",
		prepareOptimizerEval: async () => ({
			state: makeOptimizerState("idle", {
				evalFamily: "frontierswe",
				evalDataset: "frontierswe-sample@v1",
			}),
			searchSet: { totalItems: 3 },
			holdOutSet: { totalItems: 1 },
			manifest: {
				family: "frontierswe",
				dataset: "frontierswe-sample@v1",
			},
		}),
	});

	await handleQuestEvalsCommand("prepare --eval frontierswe --suite frontierswe-sample@v1", harness.deps);

	assert.equal(harness.currentOptimizerState.evalFamily, "frontierswe");
	assert.equal(harness.uiCalls, 1);
	assert.ok(harness.notes.some((note) => note.includes("Prepared frontierswe:frontierswe-sample@v1")));
});
