import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQuestHeadless } from "../src/headless-core.js";
import { replayQuestRunIntoTrialDataset } from "../src/trials-runtime.js";
import { loadQuestEvalDataset, listQuestTraceBundles } from "../src/state.js";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function makeRun(role, summary, benchmark, overrides = {}) {
	return {
		id: `${role}-${Math.random().toString(16).slice(2)}`,
		role,
		startedAt: Date.now() - 1000,
		endedAt: Date.now(),
		provider: DEFAULT_MODEL.provider,
		model: DEFAULT_MODEL.model,
		thinkingLevel: DEFAULT_MODEL.thinkingLevel,
		exitCode: 0,
		ok: true,
		summary,
		phase: role === "validator" ? "code_review" : "streaming",
		events: [],
		issues: [],
		benchmark,
		...overrides,
	};
}

test("runQuestHeadless writes a completed benchmark contract and trace provenance", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-"));
	try {
		const result = await runQuestHeadless(
			{
				cwd: repoDir,
				instruction: "Finish the benchmark task.",
				modelChoice: DEFAULT_MODEL,
				benchmark: {
					benchmark: "terminal-bench",
					dataset: "terminal-bench-sample@2.0",
					taskId: "task-001",
					runMode: "sample",
					adapterVersion: "quest-bench-v1",
				},
			},
			{
				async probe(_cwd, _modelChoice, _profile, benchmark) {
					return {
						readiness: {
							summary: "Repo checks supported.",
							checks: [{ id: "repo", surface: "repo-checks", description: "rg works", status: "supported", commands: ["rg"], evidence: [] }],
						},
						servicesYaml: null,
						run: makeRun("validator", "Captured readiness.", benchmark, { phase: "readiness" }),
					};
				},
				async planner(_cwd, _goal, _modelChoice, _readiness, _profile, benchmark) {
					return {
						plan: {
							title: "Benchmark Quest",
							summary: "Solve the task with one feature.",
							risks: [],
							environment: [],
							services: [],
							validationSummary: "Repo checks supported.",
							humanQaChecklist: ["Run manual QA before shipping."],
							milestones: [
								{
									id: "m1",
									order: 1,
									title: "Complete benchmark task",
									description: "Finish the task.",
									successCriteria: ["Task passes validation."],
									status: "pending",
								},
							],
							features: [
								{
									id: "f1",
									order: 1,
									milestoneId: "m1",
									title: "Implement task",
									description: "Do the work.",
									preconditions: [],
									fulfills: ["Task passes validation."],
									status: "pending",
								},
							],
						},
						run: makeRun("orchestrator", "Planned the quest.", benchmark, { phase: "planning" }),
					};
				},
				async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, benchmark) {
					return makeRun("worker", "Finished the feature.", benchmark, { featureId: "f1", milestoneId: "m1" });
				},
				async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, benchmark) {
					return makeRun("validator", `Validator passed ${pass}.`, benchmark, { milestoneId: "m1", phase: pass });
				},
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(result.benchmark?.benchmark, "terminal-bench");
		assert.ok(result.traceBundleIds.length >= 5);
		assert.ok(existsSync(result.artifactPaths.result));

		const traces = await listQuestTraceBundles(repoDir);
		assert.equal(traces.length, result.traceBundleIds.length);
		assert.ok(traces.every((trace) => trace.benchmark?.benchmark === "terminal-bench"));
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});

test("benchmark trace replays route into benchmark-specific datasets", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-replay-"));
	try {
		await runQuestHeadless(
			{
				cwd: repoDir,
				instruction: "Checkpoint task",
				modelChoice: DEFAULT_MODEL,
				benchmark: {
					benchmark: "slopcodebench",
					dataset: "slopcodebench-smoke",
					taskId: "trajectory-api",
					checkpointId: "checkpoint-2",
					runMode: "smoke",
					adapterVersion: "quest-bench-v1",
				},
			},
			{
				async probe(_cwd, _modelChoice, _profile, benchmark) {
					return {
						readiness: null,
						servicesYaml: null,
						run: makeRun("validator", "Readiness limited.", benchmark, { phase: "readiness" }),
					};
				},
				async planner(_cwd, _goal, _modelChoice, _readiness, _profile, benchmark) {
					return {
						plan: {
							title: "Checkpoint Quest",
							summary: "Checkpoint plan",
							risks: [],
							environment: [],
							services: [],
							validationSummary: "Validation stays limited.",
							humanQaChecklist: ["Manual QA remains required."],
							milestones: [
								{
									id: "m1",
									order: 1,
									title: "Checkpoint",
									description: "Run the checkpoint",
									successCriteria: ["Checkpoint validated."],
									status: "pending",
								},
							],
							features: [
								{
									id: "f1",
									order: 1,
									milestoneId: "m1",
									title: "Implement checkpoint",
									description: "Implement the checkpoint.",
									preconditions: [],
									fulfills: ["Checkpoint validated."],
									status: "pending",
								},
							],
						},
						run: makeRun("orchestrator", "Planned checkpoint.", benchmark, { phase: "planning" }),
					};
				},
				async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, benchmark) {
					return makeRun("worker", "Worker finished.", benchmark, { featureId: "f1", milestoneId: "m1" });
				},
				async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, benchmark) {
					return makeRun("validator", "Validation stayed limited and blocked.", benchmark, {
						milestoneId: "m1",
						phase: pass,
						ok: false,
						exitCode: 1,
						issues: ["Validation stayed limited."],
					});
				},
			},
		);

		const replayDataset = await replayQuestRunIntoTrialDataset(repoDir, "validator-fixed");
		assert.equal(replayDataset, null);

		const traces = await listQuestTraceBundles(repoDir);
		const validatorTrace = traces.find((trace) => trace.role === "validator" && trace.benchmark?.checkpointId === "checkpoint-2");
		assert.ok(validatorTrace);

		const replay = await replayQuestRunIntoTrialDataset(repoDir, validatorTrace.runId);
		assert.ok(replay);
		assert.equal(replay.kind, "slopcodebench-replays");

		const persisted = await loadQuestEvalDataset(repoDir, replay.id);
		assert.ok(persisted?.cases.some((testCase) => testCase.provenance.benchmark?.checkpointId === "checkpoint-2"));
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});
