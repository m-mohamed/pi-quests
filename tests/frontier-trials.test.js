import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectFrontierTrialStatus, prepareTrialBenchmark, runTrialBaseline, runTrialOptimization } from "../src/frontier-trials.js";
import { getQuestTrialPaths } from "../src/state.js";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function fakeScorecard(split, meanScore, totalCost, totalDurationMs, benchmarkMetrics = undefined) {
	const perItemScore = split.items.length > 0 ? meanScore : 0;
	return {
		family: split.family,
		split: split.split,
		dataset: split.dataset,
		generatedAt: Date.now(),
		itemCount: split.items.length,
		passed: Math.round(split.items.length * meanScore),
		failed: split.items.length - Math.round(split.items.length * meanScore),
		totalScore: perItemScore * split.items.length,
		maxScore: split.items.length,
		meanScore,
		totalCost,
		totalDurationMs,
		benchmarkMetrics,
		items: split.items.map((item) => ({
			itemId: item.id,
			itemName: item.name,
			family: split.family,
			dataset: split.dataset,
			split: split.split,
			status: perItemScore >= 1 ? "passed" : perItemScore > 0 ? "failed" : "error",
			score: perItemScore,
			maxScore: 1,
			durationMs: Math.floor(totalDurationMs / Math.max(1, split.items.length)),
			totalCost: totalCost / Math.max(1, split.items.length),
			modelChoice: "openai-codex/gpt-5.4",
			artifactPaths: [],
		})),
	};
}

async function seedCommunityDir(cwd) {
	const paths = getQuestTrialPaths(cwd);
	await mkdir(paths.communityTracesDir, { recursive: true });
	await writeFile(join(paths.communityTracesDir, "placeholder.jsonl"), "{\"type\":\"session\"}\n", "utf-8");
}

async function createFakeSlopRepo(problemCount = 20) {
	const repo = await mkdtemp(join(tmpdir(), "pi-quests-slop-repo-"));
	for (let index = 0; index < problemCount; index += 1) {
		const slug = `problem-${String(index + 1).padStart(2, "0")}`;
		const category = index % 2 === 0 ? "cli" : "api";
		const problemDir = join(repo, "problems", slug);
		await mkdir(problemDir, { recursive: true });
		await writeFile(
			join(problemDir, "config.yaml"),
			[
				`name: ${slug}`,
				`category: ${category}`,
				"difficulty: medium",
				`description: ${slug} description`,
				"checkpoints:",
				"  checkpoint_one:",
				"    prompt: first",
				"  checkpoint_two:",
				"    prompt: second",
				"",
			].join("\n"),
			"utf-8",
		);
	}
	return repo;
}

test("prepareTrialBenchmark writes the deterministic 7/3 sample split", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-prepare-"));
	try {
		const prepared = await prepareTrialBenchmark(cwd, { dataset: "terminal-bench-sample@2.0" });
		assert.equal(prepared.manifest.totalItems, 10);
		assert.equal(prepared.searchSet.totalItems, 7);
		assert.equal(prepared.holdOutSet.totalItems, 3);
		assert.equal(prepared.searchSet.items.length, 7);
		assert.equal(prepared.holdOutSet.items.length, 3);
		assert.equal(prepared.searchSet.items.some((item) => item.name.includes("/")), false);
		assert.equal(prepared.holdOutSet.items.some((item) => item.name.includes("/")), false);
		assert.ok(prepared.manifest.items.every((item) => item.tags.includes("terminal-bench")));
		assert.ok((prepared.searchSet.tagSummary["terminal-bench"] ?? 0) > 0);
		assert.ok((prepared.holdOutSet.tagSummary["terminal-bench"] ?? 0) > 0);
		assert.equal(new Set([...prepared.searchSet.items, ...prepared.holdOutSet.items].map((item) => item.name)).size, 10);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runTrialOptimization passes leader failure categories into proposer context", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-failure-cats-"));
	try {
		await seedCommunityDir(cwd);
		let capturedContext = null;
		await runTrialOptimization(
			cwd,
			DEFAULT_MODEL,
			{ iterations: 1 },
			{
				analyzeCommunity: async () => ({
					generatedAt: Date.now(),
					totalFiles: 1,
					totalSessions: 1,
					parsedSessions: 1,
					failedSessions: 0,
					failedPaths: [],
					sources: {},
					models: {},
					providers: {},
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheRead: 0,
					totalCacheWrite: 0,
					totalCost: 0,
					avgDurationMs: 0,
					avgToolCalls: 0,
					avgErrors: 0,
					avgMessages: 0,
					failureTags: { weak_validation: 2 },
					topToolNames: {},
					sessionDurationBuckets: [],
				}),
				proposeCandidate: async (_cwd, _model, _profile, _target, context) => {
					capturedContext = context;
					return {
						run: {
							id: "proposer-run",
							role: "proposer",
							startedAt: Date.now(),
							endedAt: Date.now(),
							provider: DEFAULT_MODEL.provider,
							model: DEFAULT_MODEL.model,
							thinkingLevel: DEFAULT_MODEL.thinkingLevel,
							exitCode: 0,
							ok: true,
							summary: "Candidate",
							phase: "propose",
							events: [],
						},
						candidate: {
							id: "candidate-agent",
							source: "agent",
							summary: "Candidate",
							rationale: "Candidate rationale",
							generalizationNote: "Candidate generalization note",
							targetedTags: ["weak_validation"],
							targetedCaseIds: [],
							promptSurfaceIds: ["feature-worker"],
							patch: { promptSurfaces: { workerPolicy: "New worker policy" } },
						},
					};
				},
				runBenchmarkSet: async (_cwd, _model, _profileId, split, candidateId) => {
					if (candidateId === "000") {
						return fakeScorecard(split, 0.4, 5, 500, { failureCategories: { score_shortfall: 4, self_check_failed: 2 } });
					}
					return fakeScorecard(split, 1, 1, 200, { failureCategories: {} });
				},
			},
		);
		assert.deepEqual(capturedContext?.leaderSummary?.failureCategoryBreakdown, {
			score_shortfall: 4,
			self_check_failed: 2,
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("prepareTrialBenchmark discovers slopcodebench manifests and writes a deterministic 14/6 split", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-slop-prepare-"));
	const repo = await createFakeSlopRepo(20);
	try {
		const prepared = await prepareTrialBenchmark(cwd, {
			benchmark: "slopcodebench",
			dataset: "slopcodebench@official",
			repo,
		});
		assert.equal(prepared.manifest.family, "slopcodebench");
		assert.equal(prepared.manifest.totalItems, 20);
		assert.equal(prepared.searchSet.totalItems, 14);
		assert.equal(prepared.holdOutSet.totalItems, 6);
		assert.ok(prepared.manifest.sourceFingerprint.length > 10);
		assert.ok(prepared.searchSet.items.every((item) => item.family === "slopcodebench"));
		assert.ok(prepared.searchSet.items.every((item) => item.tags.includes("slopcodebench")));
		assert.ok((prepared.searchSet.tagSummary.cli ?? 0) > 0);
		assert.ok((prepared.searchSet.tagSummary.api ?? 0) > 0);
		assert.ok((prepared.holdOutSet.tagSummary.cli ?? 0) > 0);
		assert.ok((prepared.holdOutSet.tagSummary.api ?? 0) > 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(repo, { recursive: true, force: true });
	}
});

test("runTrialBaseline archives candidate 000 under the canonical trials layout", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-baseline-"));
	try {
		const baseline = await runTrialBaseline(
			cwd,
			DEFAULT_MODEL,
			{},
			{
				runBenchmarkSet: async (_cwd, _model, _profileId, split, candidateId) =>
					fakeScorecard(split, 1, candidateId === "000" ? 2 : 1, split.split === "search" ? 700 : 300),
			},
		);
		const candidateSummaryPath = join(cwd, ".pi", "quests", "trials", "candidates", "000", "summary.json");
		const candidateSummary = JSON.parse(await readFile(candidateSummaryPath, "utf-8"));
		assert.ok(existsSync(candidateSummaryPath));
		assert.equal(baseline.candidate.candidateId, "000");
		assert.equal(candidateSummary.status, "frontier");
		assert.equal(baseline.state.currentCandidateId, "000");
		assert.deepEqual(baseline.state.frontierCandidateIds, ["000"]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runTrialOptimization promotes a non-dominated proposer candidate and updates current/profile.json", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-run-"));
	try {
		await seedCommunityDir(cwd);
		const result = await runTrialOptimization(
			cwd,
			DEFAULT_MODEL,
			{ iterations: 1 },
			{
				analyzeCommunity: async () => ({
					generatedAt: Date.now(),
					totalFiles: 1,
					totalSessions: 1,
					parsedSessions: 1,
					failedSessions: 0,
					failedPaths: [],
					sources: {},
					models: {},
					providers: {},
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheRead: 0,
					totalCacheWrite: 0,
					totalCost: 0,
					avgDurationMs: 0,
					avgToolCalls: 0,
					avgErrors: 0,
					avgMessages: 0,
					failureTags: { weak_validation: 3 },
					topToolNames: {},
					sessionDurationBuckets: [],
				}),
				proposeCandidate: async (_cwd, _model, _profile, _target, _context) => ({
					run: {
						id: "proposer-run",
						role: "proposer",
						startedAt: Date.now(),
						endedAt: Date.now(),
						provider: DEFAULT_MODEL.provider,
						model: DEFAULT_MODEL.model,
						thinkingLevel: DEFAULT_MODEL.thinkingLevel,
						exitCode: 0,
						ok: true,
						summary: "Improve worker validation wording",
						phase: "propose",
						events: [],
					},
					candidate: {
						id: "candidate-agent",
						source: "agent",
						summary: "Tighten worker validation language",
						rationale: "Improves validation specificity across benchmark tasks.",
						generalizationNote: "Targets repeated weak-validation failures rather than one task.",
						targetedTags: ["weak_validation"],
						targetedCaseIds: [],
						promptSurfaceIds: ["feature-worker"],
						patch: {
							promptSurfaces: {
								workerPolicy: "Confirm prerequisites early and state validation limits explicitly.",
							},
						},
					},
				}),
				runBenchmarkSet: async (_cwd, _model, _profileId, split, candidateId) => {
					if (candidateId === "000") {
						return fakeScorecard(split, 0.5, 5, split.split === "search" ? 900 : 400);
					}
					return fakeScorecard(split, split.split === "search" ? 0.9 : 1, 2, split.split === "search" ? 500 : 250);
				},
			},
		);
		const status = await collectFrontierTrialStatus(cwd);
		const currentProfile = JSON.parse(await readFile(join(cwd, ".pi", "quests", "trials", "current", "profile.json"), "utf-8"));
		const candidate001Summary = JSON.parse(await readFile(join(cwd, ".pi", "quests", "trials", "candidates", "001", "summary.json"), "utf-8"));
		assert.equal(result.frontier.leaderCandidateId, "001");
		assert.deepEqual(status.frontier?.frontierCandidateIds, ["001"]);
		assert.equal(status.leader?.candidateId, "001");
		assert.equal(candidate001Summary.status, "frontier");
		assert.match(currentProfile.id, /candidate-001$/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runTrialOptimization rejects candidates that regress hold-out performance", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-frontier-reject-"));
	try {
		await seedCommunityDir(cwd);
		await runTrialOptimization(
			cwd,
			DEFAULT_MODEL,
			{ iterations: 1 },
			{
				analyzeCommunity: async () => ({
					generatedAt: Date.now(),
					totalFiles: 1,
					totalSessions: 1,
					parsedSessions: 1,
					failedSessions: 0,
					failedPaths: [],
					sources: {},
					models: {},
					providers: {},
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheRead: 0,
					totalCacheWrite: 0,
					totalCost: 0,
					avgDurationMs: 0,
					avgToolCalls: 0,
					avgErrors: 0,
					avgMessages: 0,
					failureTags: { weak_validation: 1 },
					topToolNames: {},
					sessionDurationBuckets: [],
				}),
				proposeCandidate: async () => ({
					run: {
						id: "proposer-run",
						role: "proposer",
						startedAt: Date.now(),
						endedAt: Date.now(),
						provider: DEFAULT_MODEL.provider,
						model: DEFAULT_MODEL.model,
						thinkingLevel: DEFAULT_MODEL.thinkingLevel,
						exitCode: 0,
						ok: true,
						summary: "Candidate",
						phase: "propose",
						events: [],
					},
					candidate: {
						id: "candidate-agent",
						source: "agent",
						summary: "Candidate",
						rationale: "Candidate rationale",
						generalizationNote: "Candidate generalization note",
						targetedTags: ["weak_validation"],
						targetedCaseIds: [],
						promptSurfaceIds: ["feature-worker"],
						patch: { promptSurfaces: { workerPolicy: "New worker policy" } },
					},
				}),
				runBenchmarkSet: async (_cwd, _model, _profileId, split, candidateId) => {
					if (candidateId === "000") {
						return fakeScorecard(split, split.split === "search" ? 0.5 : 1, 5, 500);
					}
					return fakeScorecard(split, split.split === "search" ? 0.9 : 0.2, 1, 200);
				},
			},
		);
		const rejected = JSON.parse(await readFile(join(cwd, ".pi", "quests", "trials", "candidates", "001", "summary.json"), "utf-8"));
		const status = await collectFrontierTrialStatus(cwd);
		assert.equal(rejected.status, "rejected");
		assert.equal(status.frontier?.leaderCandidateId, "000");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
