import assert from "node:assert/strict";
import test from "node:test";
import { handleQuestTrialsCommand, openQuestTrialsControl } from "../src/quest-trials-controller.js";

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

function makeTrialState(status = "idle", overrides = {}) {
	return {
		projectId: "repo-project",
		target: "repo",
		activeProfileId: "repo-test",
		storageVersion: 3,
		frontierCandidateIds: [],
		status,
		updatedAt: Date.now(),
		...overrides,
	};
}

function createDeps(trials, options = {}) {
	let currentQuest = options.currentQuest ?? null;
	let currentTrialState = options.currentTrialState ?? makeTrialState();
	let currentProfile = options.currentProfile ?? makeProfile();
	let trialLiveRun = options.trialLiveRun ?? null;
	let activeTrialPid = options.activeTrialPid;
	const notes = [];
	let uiCalls = 0;

	return {
		notes,
		get currentTrialState() {
			return currentTrialState;
		},
		get trialLiveRun() {
			return trialLiveRun;
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
			getCurrentTrialState: () => currentTrialState,
			getCurrentProfile: () => currentProfile,
			getTrialLiveRun: () => trialLiveRun,
			getActiveTrialPid: () => activeTrialPid,
			setCurrentTrialState: (state) => {
				currentTrialState = state;
			},
			setCurrentProfile: (profile) => {
				currentProfile = profile;
			},
			setTrialLiveRun: (snapshot) => {
				trialLiveRun = snapshot;
			},
			setActiveTrialPid: (pid) => {
				activeTrialPid = pid;
			},
			emitNote: async (content) => {
				notes.push(content);
			},
			applyQuestUi: async () => {
				uiCalls += 1;
			},
			internalModeEnabled: true,
			loadFrontierTrials: async () => trials,
		},
	};
}

test("openQuestTrialsControl summarizes the live trial state instead of stale snapshots", async () => {
	const profile = makeProfile();
	const { deps, notes } = createDeps(
		{
			collectFrontierTrialStatus: async () => ({
				state: makeTrialState("idle"),
				profile,
			}),
			summarizeTrialStatus: () => "idle summary",
		},
		{
			trialLiveRun: {
				role: "trial",
				phase: "baseline-search",
				latestToolName: "bash",
				updatedAt: Date.now(),
			},
		},
	);

	await openQuestTrialsControl(deps);

	assert.equal(notes.length, 1);
	assert.match(notes[0], /idle summary/);
	assert.match(notes[0], /Active trial run:\s+idle/);
});

test("handleQuestTrialsCommand uses refreshed trial status instead of captured running state", async () => {
	let optimizationRuns = 0;
	const profile = makeProfile();
	const { deps, notes } = createDeps(
		{
			collectFrontierTrialStatus: async () => ({
				state: makeTrialState("idle"),
				profile,
			}),
			summarizeTrialStatus: () => "idle summary",
			runTrialOptimization: async () => {
				optimizationRuns += 1;
				return {
					state: makeTrialState("idle"),
					profile,
					summary: "optimization complete",
				};
			},
		},
		{
			currentTrialState: makeTrialState("running"),
		},
	);

	await handleQuestTrialsCommand("run", deps);

	assert.equal(optimizationRuns, 1);
	assert.equal(notes.includes("Trials are already running."), false);
	assert.ok(notes.some((note) => note.includes("optimization complete")));
});

test("handleQuestTrialsCommand refreshes the Quest UI after prepare-eval", async () => {
	const profile = makeProfile();
	const harness = createDeps({
		collectFrontierTrialStatus: async () => ({
			state: makeTrialState("idle"),
			profile,
		}),
		summarizeTrialStatus: () => "idle summary",
		prepareTrialEval: async () => ({
			state: makeTrialState("idle", {
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

	await handleQuestTrialsCommand("prepare-eval --eval frontierswe --suite frontierswe-sample@v1", harness.deps);

	assert.equal(harness.currentTrialState.evalFamily, "frontierswe");
	assert.equal(harness.uiCalls, 1);
	assert.ok(harness.notes.some((note) => note.includes("Prepared frontierswe:frontierswe-sample@v1")));
});
