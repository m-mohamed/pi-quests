import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	EvalRunInterruptedError,
	collectFrontierTrialStatus,
	prepareTrialEval,
	runTrialBaseline,
	runTrialOptimization,
} from "../src/frontier-trials.js";
import { getQuestTrialPaths, loadQuestTrialState, saveQuestTrialState } from "../src/state-core.js";

const MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4-mini",
	thinkingLevel: "high",
};

function makeScorecard(split, candidateId, meanScore, dataset = "frontierswe-sample@v1") {
	const itemId = `${candidateId}-${split}-task`;
	return {
		family: "frontierswe",
		split,
		dataset,
		generatedAt: Date.now(),
		itemCount: 1,
		passed: meanScore > 0 ? 1 : 0,
		failed: meanScore > 0 ? 0 : 1,
		totalScore: meanScore,
		maxScore: 1,
		meanScore,
		totalCost: 0,
		totalDurationMs: 10,
		tagBreakdown: {
			frontierswe: {
				itemCount: 1,
				passed: meanScore > 0 ? 1 : 0,
				totalScore: meanScore,
				meanScore,
				totalCost: 0,
				totalDurationMs: 10,
			},
		},
		evalMetrics: {
			candidateId,
		},
		items: [
			{
				itemId,
				itemName: itemId,
				family: "frontierswe",
				dataset,
				split,
				status: meanScore > 0 ? "passed" : "failed",
				score: meanScore,
				maxScore: 1,
				durationMs: 10,
				totalCost: 0,
				modelChoice: `${MODEL.provider}/${MODEL.model}:${MODEL.thinkingLevel}`,
				artifactPaths: [],
				evaluation: {
					name: "frontierswe",
					dataset,
					taskId: itemId,
					runMode: "sample",
					adapterVersion: "frontierswe-sample-v1",
					recordedAt: Date.now(),
					model: `${MODEL.provider}/${MODEL.model}:${MODEL.thinkingLevel}`,
					passed: meanScore > 0,
					score: meanScore,
				},
				evalMetrics: {
					workItemTags: ["frontierswe"],
				},
			},
		],
	};
}

test("prepareTrialEval discovers the vendored FrontierSWE sample suite", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-prepare-"));
	try {
		const prepared = await prepareTrialEval(cwd, { eval: "frontierswe", suite: "frontierswe-sample@v1" });
		const state = await loadQuestTrialState(cwd, { ensure: true });

		assert.equal(prepared.manifest.family, "frontierswe");
		assert.equal(prepared.manifest.dataset, "frontierswe-sample@v1");
		assert.equal(prepared.manifest.items.length, 4);
		assert.equal(prepared.searchSet.totalItems, 3);
		assert.equal(prepared.holdOutSet.totalItems, 1);
		assert.ok(prepared.manifest.items.every((item) => item.tags.includes("frontierswe")));
		assert.equal(state.evalFamily, "frontierswe");
		assert.equal(state.evalDataset, "frontierswe-sample@v1");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runTrialBaseline materializes a partial candidate when an eval run is interrupted", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-interrupt-"));
	try {
		const result = await runTrialBaseline(
			cwd,
			MODEL,
			{ eval: "frontierswe", suite: "frontierswe-sample@v1" },
			{
				runEvalSet: async () => {
					throw new EvalRunInterruptedError("Eval run interrupted.");
				},
			},
		);

		assert.equal(result.state.status, "stopped");
		assert.equal(result.candidate.status, "partial");
		assert.match(result.summary, /Baseline candidate 000 stopped/);
		assert.equal(existsSync(join(getQuestTrialPaths(cwd).candidatesDir, "000", "summary.json")), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("collectFrontierTrialStatus self-heals stale running trial state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-recover-"));
	try {
		const state = await loadQuestTrialState(cwd, { ensure: true });
		state.evalFamily = "frontierswe";
		state.evalDataset = "frontierswe-sample@v1";
		state.status = "running";
		state.currentCandidateId = "000";
		state.activeRun = {
			candidateId: "000",
			phase: "search-eval",
			pid: 999999,
			split: "search",
			startedAt: Date.now() - 5000,
		};
		await saveQuestTrialState(cwd, state);

		const status = await collectFrontierTrialStatus(cwd);
		const summary = JSON.parse(await readFile(join(getQuestTrialPaths(cwd).candidatesDir, "000", "summary.json"), "utf-8"));

		assert.equal(status.state.status, "stopped");
		assert.equal(status.state.activeRun, undefined);
		assert.equal(summary.status, "partial");
		assert.match(summary.summary, /recovered from stale running state/i);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runTrialOptimization promotes the stronger FrontierSWE candidate into the frontier", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-opt-"));
	try {
		const result = await runTrialOptimization(
			cwd,
			MODEL,
			{ eval: "frontierswe", suite: "frontierswe-sample@v1", iterations: 1 },
			{
				analyzeCommunity: async () => ({
					generatedAt: Date.now(),
					totalSessions: 1,
					parsedSessions: 1,
					failedSessions: 0,
					failedPaths: [],
					models: {},
					providers: {},
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheRead: 0,
					totalCacheWrite: 0,
					totalCost: 0,
					totalDurationMs: 0,
					totalToolCalls: 0,
					totalErrors: 0,
					totalMessages: 0,
					failureTags: {},
					sourceStats: [],
					topFailureCaseIds: [],
					failureCategoryCounts: {},
					topToolNames: {},
					sessionDurationBuckets: [],
				}),
				proposeCandidate: async () => ({
					candidate: {
						id: "proposal-1",
						source: "agent",
						summary: "Tighten eval execution guidance.",
						rationale: "Improve verifier discipline on sample tasks.",
						generalizationNote: "Should generalize across FrontierSWE task styles.",
						targetedTags: [],
						targetedCaseIds: [],
						promptSurfaceIds: ["feature-worker"],
						patch: {
							promptSurfaces: {
								workerPolicy: "Prefer exact verifier-owned outputs and explicit self-checks.",
							},
						},
					},
					run: null,
				}),
				runEvalSet: async (_cwd, _modelChoice, _profileId, split, candidateId) => {
					if (candidateId === "000") return makeScorecard(split.split, candidateId, 0.2, split.dataset);
					return makeScorecard(split.split, candidateId, 0.9, split.dataset);
				},
			},
		);

		assert.equal(result.state.status, "idle");
		assert.equal(result.leader?.candidateId, "001");
		assert.deepEqual(result.frontier.frontierCandidateIds, ["001"]);
		assert.match(result.summary, /Candidate 001 archived/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
