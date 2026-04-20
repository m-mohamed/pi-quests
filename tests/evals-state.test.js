import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getQuestOptimizerPaths, loadQuestProfile, loadQuestOptimizerState, saveQuestProfile } from "../src/state-core.js";

test("loadQuestOptimizerState initializes only canonical eval optimizer storage", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-evals-state-"));
	try {
		const paths = getQuestOptimizerPaths(cwd);
		await mkdir(join(paths.rootDir, "datasets"), { recursive: true });
		await mkdir(join(paths.rootDir, "experiments"), { recursive: true });
		await mkdir(join(paths.rootDir, "baselines"), { recursive: true });
		await mkdir(join(paths.rootDir, "reports"), { recursive: true });

		const state = await loadQuestOptimizerState(cwd, { ensure: true });
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });

		assert.equal(state.storageVersion, 4);
		assert.equal(state.evalFamily, "frontierswe");
		assert.equal(state.evalDataset, "frontierswe-sample@v1");
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

test("loadQuestOptimizerState rejects unsupported pre-cutover state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-evals-legacy-"));
	try {
		const paths = getQuestOptimizerPaths(cwd);
		await mkdir(paths.rootDir, { recursive: true });
		await writeFile(
			paths.stateFile,
			`${JSON.stringify({
				projectId: "repo-project",
				target: "repo",
				activeProfileId: "repo-project",
				storageVersion: 3,
				currentCandidateId: "999",
				frontierCandidateIds: ["999"],
				status: "running",
				activeRun: { candidateId: "999", phase: "search-eval", startedAt: Date.now() },
			}, null, 2)}\n`,
			"utf-8",
		);

		await assert.rejects(
			() => loadQuestOptimizerState(cwd, { ensure: true }),
			/Delete \.pi\/quests\/evals\/ and rerun `\/quest evals prepare`/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("saveQuestProfile keeps current/profile.json and profiles/<id>.json in sync", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-evals-profile-"));
	try {
		const state = await loadQuestOptimizerState(cwd, { ensure: true });
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
		profile.promptSurfaces.workerPolicy = "Confirm prerequisites and eval constraints before editing.";
		await saveQuestProfile(cwd, profile);

		const paths = getQuestOptimizerPaths(cwd);
		const currentProfile = JSON.parse(await readFile(paths.currentProfileFile, "utf-8"));
		const stagedProfile = JSON.parse(await readFile(join(paths.profilesDir, `${profile.id}.json`), "utf-8"));

		assert.equal(currentProfile.id, profile.id);
		assert.equal(stagedProfile.id, profile.id);
		assert.match(currentProfile.promptSurfaces.workerPolicy, /^Confirm prerequisites and eval constraints before editing\./);
		assert.match(stagedProfile.promptSurfaces.workerPolicy, /^Confirm prerequisites and eval constraints before editing\./);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
