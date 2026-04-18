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

function makeRun(role, summary, evaluation, overrides = {}) {
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
		evaluation,
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

test("runInternalQuestHeadless writes a completed eval contract and trace provenance", async () => {
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
					instruction: "Finish the eval task.",
					modelChoice: DEFAULT_MODEL,
					evaluation: {
						name: "frontierswe",
						dataset: "frontierswe-sample@v1",
						taskId: "task-001",
						runMode: "sample",
						adapterVersion: "frontierswe-sample-v1",
					},
				},
				{
					async probe(_cwd, _modelChoice, _profile, evaluation) {
						probeCalls += 1;
						return {
							readiness: {
								summary: "Repo checks supported.",
								checks: [{ id: "repo", surface: "repo-checks", description: "rg works", status: "supported", commands: ["rg"], evidence: [] }],
							},
							servicesYaml: null,
							run: makeRun("validator", "Captured readiness.", evaluation, { phase: "readiness" }),
						};
					},
					async planner(_cwd, _goal, _modelChoice, _readiness, _profile, evaluation) {
						plannerCalls += 1;
						return {
							plan: {
								title: "Eval Quest",
								summary: "Solve the task with one feature.",
								risks: [],
								environment: [],
								services: [],
								validationSummary: "Repo checks supported.",
								humanQaChecklist: ["Run manual QA before shipping."],
								milestones: [{ id: "m1", order: 1, title: "Complete eval task", description: "Finish the task.", successCriteria: ["Task passes validation."], status: "pending" }],
								features: [{ id: "f1", order: 1, milestoneId: "m1", title: "Implement task", description: "Do the work.", preconditions: [], fulfills: ["Task passes validation."], status: "pending" }],
							},
							run: makeRun("orchestrator", "Planned the quest.", evaluation, { phase: "planning" }),
						};
					},
					async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, evaluation) {
						workerCalls += 1;
						return makeRun("worker", "Finished the feature.", evaluation, { featureId: "f1", milestoneId: "m1" });
					},
					async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, evaluation) {
						validatorCalls += 1;
						return makeRun("validator", `Validator passed ${pass}.`, evaluation, { milestoneId: "m1", phase: pass });
					},
				},
			);

			assert.equal(result.status, "completed");
			assert.equal(result.evaluation?.name, "frontierswe");
			assert.equal(probeCalls, 0);
			assert.equal(plannerCalls, 0);
			assert.equal(validatorCalls, 0);
			assert.equal(workerCalls, 1);
			assert.equal(result.traceBundleIds.length, 1);
			assert.ok(existsSync(result.artifactPaths.result));

			const traces = await listQuestTraceBundles(repoDir);
			assert.equal(traces.length, result.traceBundleIds.length);
			assert.ok(traces.every((trace) => trace.role === "worker"));
			assert.ok(traces.every((trace) => trace.evaluation?.name === "frontierswe"));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});

test("eval trace bundles preserve checkpoint provenance without replay datasets", async () => {
	await withInternalMode(async () => {
		const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-replay-"));
		try {
			let workerCalls = 0;
			const result = await runInternalQuestHeadless(
				{
					cwd: repoDir,
					instruction: "Checkpoint task",
					modelChoice: DEFAULT_MODEL,
					evaluation: {
						name: "frontierswe",
						dataset: "frontierswe@public-v1",
						taskId: "trajectory-api",
						checkpointId: "checkpoint-2",
						runMode: "full",
						adapterVersion: "frontier-v2",
					},
				},
				{
					async probe(_cwd, _modelChoice, _profile, evaluation) {
						throw new Error(`eval fast path should not call probe: ${evaluation?.taskId ?? "unknown"}`);
					},
					async planner(_cwd, _goal, _modelChoice, _readiness, _profile, evaluation) {
						throw new Error(`eval fast path should not call planner: ${evaluation?.taskId ?? "unknown"}`);
					},
					async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, evaluation) {
						workerCalls += 1;
						return makeRun("worker", "Worker finished.", evaluation, { featureId: "f1", milestoneId: "m1" });
					},
					async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass, _profile, evaluation) {
						throw new Error(`eval fast path should not call validator ${pass}: ${evaluation?.taskId ?? "unknown"}`);
					},
				},
			);

			const traces = await listQuestTraceBundles(repoDir);
			assert.equal(result.status, "completed");
			assert.equal(workerCalls, 1);
			assert.equal(result.evaluation?.name, "frontierswe");
			assert.equal(result.evaluation?.checkpointId, "checkpoint-2");
			assert.ok(existsSync(result.artifactPaths.result));
			const workerTrace = traces.find((trace) => trace.role === "worker" && trace.evaluation?.checkpointId === "checkpoint-2");
			assert.ok(workerTrace);
			assert.ok(traces.every((trace) => trace.evaluation?.name === "frontierswe"));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});

test("runInternalQuestHeadless blocks eval runs with unresolved execution findings", async () => {
	await withInternalMode(async () => {
		const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-blocked-"));
		try {
			let validatorCalls = 0;
			const result = await runInternalQuestHeadless(
				{
					cwd: repoDir,
					instruction: "Finish the eval task.",
					modelChoice: DEFAULT_MODEL,
					evaluation: {
						name: "frontierswe",
						dataset: "frontierswe-sample@v1",
						taskId: "task-002",
						runMode: "sample",
						adapterVersion: "frontierswe-sample-v1",
					},
				},
				{
					async probe() {
						throw new Error("eval fast path should not call probe");
					},
					async planner() {
						throw new Error("eval fast path should not call planner");
					},
					async worker(_quest, _feature, _milestone, _modelChoice, _workflows, _profile, evaluation) {
						return makeRun("worker", "Worker stopped with unresolved handoff.", evaluation, {
							ok: true,
							issues: ["Worker requested human handoff during eval execution."],
							featureId: "f1",
							milestoneId: "m1",
						});
					},
					async validator() {
						validatorCalls += 1;
						throw new Error("eval fast path should not call validator");
					},
				},
			);

			assert.equal(result.status, "blocked");
			assert.deepEqual(result.executionFindings, ["Worker requested human handoff during eval execution."]);
			assert.equal(result.failureCategory, "human_handoff");
			assert.equal(validatorCalls, 0);
			assert.ok(existsSync(result.artifactPaths.result));
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	});
});
