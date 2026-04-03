import test from "node:test";
import assert from "node:assert/strict";
import { deriveLearnedWorkflows, mergeLearnedWorkflows } from "../src/workflows.js";

test("mergeLearnedWorkflows keeps unique titles and merges evidence", () => {
	const merged = mergeLearnedWorkflows(
		[
			{
				id: "wf-1",
				title: "Start Docker before quest checks",
				note: "Run Docker first.",
				source: "validator_failure",
				createdAt: 1,
				updatedAt: 1,
				evidence: ["docker not running"],
			},
		],
		[
			{
				id: "wf-2",
				title: "Start Docker before quest checks",
				note: "Run Docker before validation.",
				source: "validator_success",
				createdAt: 2,
				updatedAt: 2,
				evidence: ["docker compose up"],
			},
		],
	);

	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].evidence.sort(), ["docker compose up", "docker not running"]);
});

test("deriveLearnedWorkflows extracts stable project guidance from runs", () => {
	const workflows = deriveLearnedWorkflows({
		id: "run-1",
		role: "validator",
		startedAt: Date.now() - 1000,
		endedAt: Date.now(),
		provider: "openai-codex",
		model: "gpt-5.4",
		thinkingLevel: "high",
		exitCode: 1,
		ok: false,
		summary: "Docker was not running before npm run dev",
		stderr: "docker not found",
		phase: "completed",
		events: [],
	});

	assert.equal(workflows.length > 0, true);
	assert.match(workflows[0].title, /Docker|command/i);
});
