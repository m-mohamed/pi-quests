import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getQuestTrialPaths, loadQuestTrialState, loadQuestProfile } from "../src/state.js";

test("loadQuestTrialState migrates legacy lab state and ignores inconsistent meta-harness artifacts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-trials-state-"));
	try {
		const labDir = join(cwd, ".pi", "quests", "lab");
		const metaHarnessDir = join(cwd, ".pi", "quests", "meta-harness");
		await mkdir(join(labDir, "profiles"), { recursive: true });
		await mkdir(join(metaHarnessDir, "traces", "community"), { recursive: true });

		const legacyState = {
			projectId: "legacy-project",
			target: "repo",
			activeProfileId: "repo-legacy-project",
			status: "idle",
			updatedAt: Date.now(),
		};
		const legacyProfile = {
			id: "repo-legacy-project",
			projectId: "legacy-project",
			target: "repo",
			title: "Legacy Profile",
			updatedAt: Date.now(),
			promptSurfaces: {
				version: 1,
				planningPolicy: "legacy planning",
				workerPolicy: "legacy worker",
				validatorCodeReviewPolicy: "legacy validator",
				validatorUserSurfacePolicy: "legacy user validator",
				readinessPolicy: "legacy readiness",
				revisionPolicy: "legacy revision",
				proposerPolicy: "legacy proposer",
			},
			toolAllowlist: {
				orchestrator: ["read"],
				worker: ["read"],
				validator: ["read"],
				trial: ["read"],
				proposer: ["read"],
			},
			modelPolicy: { preferSameModelFamily: true, preferValidatorDivergence: false },
			ensemblePolicy: {
				enabled: false,
				families: [],
				defaultWorker: "",
				defaultValidator: "",
				escalationThreshold: 0,
				autoEscalateOnFailure: false,
				routingRules: [],
			},
			verificationBudget: { workerAttempts: 1, validatorAttempts: 1, correctiveFeatureBudget: 1 },
			contextPolicy: { spillThresholdChars: 1000, spillLongOutputsToReports: true, maxInlineEvidenceLines: 6 },
			workflowHintPolicy: { maxSharedHints: 4, promotePrerequisiteHints: true, promoteFailureHints: true },
			traceGrading: {
				toolHeavyCount: 6,
				longRunMs: 1000,
				repeatedCorrectiveThreshold: 2,
				weakValidationPenalty: 0.2,
				blockedPenalty: 0.2,
				overflowPenalty: 0.2,
				abortPenalty: 0.1,
			},
			harnessPolicy: {
				computationalGuides: { enabled: false, linterConfigs: [], preCommitHooks: [], structuralTests: [], archConstraints: [] },
				inferentialGuides: { enabled: false, agentsMdPath: "", skillsDir: "", codeReviewAgents: [] },
				sensors: {
					computational: { enabled: false, linters: [], typeCheckers: [], testRunners: [], driftDetectors: [] },
					inferential: { enabled: false, codeReviewAgents: [], qualityJudges: [], runtimeMonitors: [] },
				},
				fitnessFunctions: { enabled: false, performanceRequirements: [], observabilityRequirements: [], architectureConstraints: [] },
			},
			adoptedChanges: [],
		};

		await writeFile(join(labDir, "state.json"), `${JSON.stringify(legacyState, null, 2)}\n`, "utf-8");
		await writeFile(join(labDir, "profiles", "repo-legacy-project.json"), `${JSON.stringify(legacyProfile, null, 2)}\n`, "utf-8");
		await writeFile(
			join(metaHarnessDir, "search-set.json"),
			`${JSON.stringify({ id: "bad-search", totalTasks: 7, tasks: [{ name: "one", path: "one" }] }, null, 2)}\n`,
			"utf-8",
		);
		await writeFile(
			join(metaHarnessDir, "hold-out-set.json"),
			`${JSON.stringify({ id: "good-holdout", totalTasks: 1, tasks: [{ name: "one", path: "one" }] }, null, 2)}\n`,
			"utf-8",
		);
		symlinkSync(join(metaHarnessDir, "missing-community-target"), join(metaHarnessDir, "traces", "community", "broken"));

		const state = await loadQuestTrialState(cwd, { ensure: true });
		const paths = getQuestTrialPaths(cwd);
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
		const copiedHoldOut = JSON.parse(await readFile(paths.holdOutSetFile, "utf-8"));

		assert.equal(state.activeProfileId, "repo-legacy-project");
		assert.equal(state.storageVersion, 2);
		assert.equal(profile.title, "Legacy Profile");
		assert.equal(existsSync(paths.currentProfileFile), true);
		assert.equal(existsSync(paths.searchSetFile), false);
		assert.equal(copiedHoldOut.totalTasks, 1);
		assert.equal(existsSync(join(paths.communityTracesDir, "broken")), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
