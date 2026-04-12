import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInternalQuestHeadless } from "../src/internal-headless.js";
import { listQuestTraceBundles } from "../src/state-core.js";

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

async function withInternalMode(run) {
	const previous = process.env.PI_QUESTS_INTERNAL;
	process.env.PI_QUESTS_INTERNAL = "1";
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PI_QUESTS_INTERNAL;
		else process.env.PI_QUESTS_INTERNAL = previous;
	}
}

test("runQuestHeadless writes a completed benchmark contract and trace provenance", async () => {
	await withInternalMode(async () => {
		const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-"));
		try {
			let probeCalls = 0;
			let plannerCalls = 0;
			let validatorCalls = 0;
			let workerCalls = 0;
			const result = await runInternalQuestHeadless(
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
					probeCalls += 1;
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
					plannerCalls += 1;
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
					workerCalls += 1;
					return makeRun("worker", "Finished the feature.", benchmark, { featureId: "f1", milestoneId: "m1" });
				},
				async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, benchmark) {
					validatorCalls += 1;
					return makeRun("validator", `Validator passed ${pass}.`, benchmark, { milestoneId: "m1", phase: pass });
				},
			},
			);

			assert.equal(result.status, "completed");
			assert.equal(result.benchmark?.benchmark, "terminal-bench");
			assert.equal(probeCalls, 0);
			assert.equal(plannerCalls, 0);
			assert.equal(validatorCalls, 0);
			assert.equal(workerCalls, 1);
			assert.equal(result.traceBundleIds.length, 1);
			assert.ok(existsSync(result.artifactPaths.result));

			const traces = await listQuestTraceBundles(repoDir);
			assert.equal(traces.length, result.traceBundleIds.length);
			assert.ok(traces.every((trace) => trace.role === "worker"));
			assert.ok(traces.every((trace) => trace.benchmark?.benchmark === "terminal-bench"));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});

test("benchmark trace bundles preserve slopcodebench provenance without replay datasets", async () => {
	await withInternalMode(async () => {
		const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-replay-"));
		try {
			let workerCalls = 0;
			const result = await runInternalQuestHeadless(
			{
				cwd: repoDir,
				instruction: "Checkpoint task",
				modelChoice: DEFAULT_MODEL,
				benchmark: {
					benchmark: "slopcodebench",
					dataset: "slopcodebench@official",
					taskId: "trajectory-api",
					checkpointId: "checkpoint-2",
					runMode: "custom",
					adapterVersion: "frontier-v2",
				},
			},
			{
				async probe(_cwd, _modelChoice, _profile, benchmark) {
					throw new Error(`benchmark fast path should not call probe: ${benchmark?.taskId ?? "unknown"}`);
				},
				async planner(_cwd, _goal, _modelChoice, _readiness, _profile, benchmark) {
					throw new Error(`benchmark fast path should not call planner: ${benchmark?.taskId ?? "unknown"}`);
				},
				async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, benchmark) {
					workerCalls += 1;
					return makeRun("worker", "Worker finished.", benchmark, { featureId: "f1", milestoneId: "m1" });
				},
				async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, benchmark) {
					throw new Error(`benchmark fast path should not call validator ${pass}: ${benchmark?.taskId ?? "unknown"}`);
				},
			},
			);

			const traces = await listQuestTraceBundles(repoDir);
			assert.equal(result.status, "completed");
			assert.equal(workerCalls, 1);
			assert.equal(result.benchmark?.benchmark, "slopcodebench");
			assert.equal(result.benchmark?.checkpointId, "checkpoint-2");
			assert.ok(existsSync(result.artifactPaths.result));
			const workerTrace = traces.find((trace) => trace.role === "worker" && trace.benchmark?.checkpointId === "checkpoint-2");
			assert.ok(workerTrace);
			assert.ok(traces.every((trace) => trace.benchmark?.benchmark === "slopcodebench"));
			assert.ok(traces.some((trace) => trace.benchmark?.checkpointId === "checkpoint-2"));
			assert.ok(traces.every((trace) => trace.role === "worker"));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});

test("runQuestHeadless blocks benchmark runs with unresolved execution findings", async () => {
	await withInternalMode(async () => {
		const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-blocked-"));
		try {
			let validatorCalls = 0;
			const result = await runInternalQuestHeadless(
			{
				cwd: repoDir,
				instruction: "Finish the benchmark task.",
				modelChoice: DEFAULT_MODEL,
				benchmark: {
					benchmark: "terminal-bench",
					dataset: "terminal-bench-sample@2.0",
					taskId: "task-002",
					runMode: "sample",
					adapterVersion: "quest-bench-v1",
				},
			},
			{
				async probe() {
					throw new Error("benchmark fast path should not call probe");
				},
				async planner() {
					throw new Error("benchmark fast path should not call planner");
				},
				async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, benchmark) {
					return makeRun("worker", "Worker stopped with unresolved handoff.", benchmark, {
						ok: true,
						issues: ["Worker requested human handoff during benchmark execution."],
						featureId: "f1",
						milestoneId: "m1",
					});
				},
				async validator() {
					validatorCalls += 1;
					throw new Error("benchmark fast path should not call validator");
				},
			},
			);

			assert.equal(result.status, "blocked");
			assert.deepEqual(result.executionFindings, ["Worker requested human handoff during benchmark execution."]);
			assert.equal(result.failureCategory, "human_handoff");
			assert.equal(validatorCalls, 0);
			assert.ok(existsSync(result.artifactPaths.result));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});
