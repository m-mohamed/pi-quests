import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQuestHeadless } from "../src/headless-core.js";
import { getQuestTelemetryPaths, getQuestTrialPaths, listQuestTraceBundles } from "../src/state.js";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

function makeRun(role, summary, overrides = {}) {
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
		...overrides,
	};
}

test("runQuestHeadless executes the public quest validation loop", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "pi-quests-headless-public-"));
	try {
		let probeCalls = 0;
		let plannerCalls = 0;
		let workerCalls = 0;
		let validatorCalls = 0;
		const result = await runQuestHeadless(
			{
				cwd: repoDir,
				instruction: "Implement the repo task.",
				modelChoice: DEFAULT_MODEL,
			},
			{
				async probe() {
					probeCalls += 1;
					return {
						readiness: {
							summary: "Repo checks supported.",
							checks: [{ id: "repo", surface: "repo-checks", description: "npm test", status: "supported", commands: ["npm test"], evidence: [] }],
						},
						servicesYaml: null,
						run: makeRun("validator", "Captured readiness.", { phase: "readiness" }),
					};
				},
				async planner() {
					plannerCalls += 1;
					return {
						plan: {
							title: "Repo Quest",
							summary: "Solve the task with one feature.",
							goal: "Implement the repo task.",
							risks: [],
							environment: [],
							services: [],
							validationSummary: "Repo checks supported.",
							humanQaChecklist: ["Run human QA before shipping."],
							milestones: [
								{
									id: "m1",
									order: 1,
									title: "Complete repo task",
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
						run: makeRun("orchestrator", "Planned the quest.", { phase: "planning" }),
					};
				},
				async worker() {
					workerCalls += 1;
					return makeRun("worker", "Finished the feature.", { featureId: "f1", milestoneId: "m1" });
				},
				async validator(_quest, _milestone, _features, _modelChoice, _workflows, pass) {
					validatorCalls += 1;
					return makeRun("validator", `Validator passed ${pass}.`, { milestoneId: "m1", phase: pass });
				},
			},
		);

		assert.equal(result.status, "completed");
		assert.equal(probeCalls, 1);
		assert.equal(plannerCalls, 1);
		assert.equal(workerCalls, 1);
		assert.equal(validatorCalls, 2);
		assert.ok(existsSync(result.artifactPaths.result));

		const traces = await listQuestTraceBundles(repoDir);
		assert.equal(traces.length, result.traceBundleIds.length);
		assert.ok(traces.some((trace) => trace.role === "orchestrator"));
		assert.ok(traces.some((trace) => trace.role === "worker"));
		assert.ok(traces.some((trace) => trace.role === "validator"));
		assert.equal(existsSync(getQuestTelemetryPaths(repoDir).tracesDir), true);
		assert.equal(existsSync(join(getQuestTrialPaths(repoDir).rootDir, "traces")), false);
	} finally {
		await rm(repoDir, { recursive: true, force: true });
	}
});
