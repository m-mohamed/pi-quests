import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getQuestTrialPaths, loadQuestProfile, loadQuestTrialState, saveQuestProfile } from "../src/state.js";

test("loadQuestTrialState initializes only canonical frontier storage and ignores legacy roots", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-trials-state-"));
	try {
		const legacyLabDir = join(cwd, ".pi", "quests", "lab");
		const legacyMetaHarnessDir = join(cwd, ".pi", "quests", "meta-harness");
		await mkdir(join(legacyLabDir, "profiles"), { recursive: true });
		await mkdir(legacyMetaHarnessDir, { recursive: true });
		await writeFile(
			join(legacyLabDir, "state.json"),
			`${JSON.stringify({ activeProfileId: "repo-legacy-project", storageVersion: 2 }, null, 2)}\n`,
			"utf-8",
		);
		await writeFile(
			join(legacyMetaHarnessDir, "search-set.json"),
			`${JSON.stringify({ id: "legacy-search", totalTasks: 1, tasks: [{ name: "old-task", path: "old-task" }] }, null, 2)}\n`,
			"utf-8",
		);

		const state = await loadQuestTrialState(cwd, { ensure: true });
		const paths = getQuestTrialPaths(cwd);
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });

		assert.equal(state.storageVersion, 3);
		assert.equal(state.benchmarkFamily, "terminal-bench");
		assert.equal(state.benchmarkDataset, "terminal-bench-sample@2.0");
		assert.equal(state.activeProfileId, `repo-${state.projectId}`);
		assert.equal(profile.id, state.activeProfileId);
		assert.equal(existsSync(paths.stateFile), true);
		assert.equal(existsSync(paths.currentProfileFile), true);
		assert.equal(existsSync(join(paths.profilesDir, `${state.activeProfileId}.json`)), true);
		assert.equal(existsSync(paths.searchSetFile), false);
		assert.equal(existsSync(paths.holdOutSetFile), false);
		assert.equal(existsSync(paths.frontierFile), false);
		assert.equal(existsSync(join(paths.rootDir, "datasets")), false);
		assert.equal(existsSync(join(paths.rootDir, "experiments")), false);
		assert.equal(existsSync(join(paths.rootDir, "baselines")), false);
		assert.equal(existsSync(join(paths.rootDir, "reports")), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("saveQuestProfile keeps current/profile.json and profiles/<id>.json in sync", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-trials-profile-"));
	try {
		const state = await loadQuestTrialState(cwd, { ensure: true });
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
		profile.promptSurfaces.workerPolicy = "Confirm prerequisites and benchmark constraints before editing.";
		await saveQuestProfile(cwd, profile);

		const paths = getQuestTrialPaths(cwd);
		const currentProfile = JSON.parse(await readFile(paths.currentProfileFile, "utf-8"));
		const stagedProfile = JSON.parse(await readFile(join(paths.profilesDir, `${profile.id}.json`), "utf-8"));

		assert.equal(currentProfile.id, profile.id);
		assert.equal(stagedProfile.id, profile.id);
		assert.match(currentProfile.promptSurfaces.workerPolicy, /^Confirm prerequisites and benchmark constraints before editing\./);
		assert.match(stagedProfile.promptSurfaces.workerPolicy, /^Confirm prerequisites and benchmark constraints before editing\./);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
