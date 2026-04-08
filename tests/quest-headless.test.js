import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/quest-headless.js";

test("quest-headless keeps high thinking for non-benchmark runs by default", async () => {
	const parsed = await parseArgs(["run", "--instruction", "Solve the repo task"]);
	assert.equal(parsed.command, "run");
	assert.equal(parsed.input?.modelChoice.provider, "zai");
	assert.equal(parsed.input?.modelChoice.model, "glm-5.1");
	assert.equal(parsed.input?.modelChoice.thinkingLevel, "high");
});

test("quest-headless uses medium thinking for benchmark runs unless explicitly overridden", async () => {
	const benchmark = await parseArgs([
		"run",
		"--instruction",
		"Solve the benchmark task",
		"--benchmark",
		"terminal-bench",
		"--dataset",
		"terminal-bench-sample@2.0",
		"--task-id",
		"chess-best-move",
	]);
	assert.equal(benchmark.input?.modelChoice.thinkingLevel, "medium");

	const overridden = await parseArgs([
		"run",
		"--instruction",
		"Solve the benchmark task",
		"--benchmark",
		"terminal-bench",
		"--dataset",
		"terminal-bench-sample@2.0",
		"--task-id",
		"chess-best-move",
		"--thinking",
		"low",
	]);
	assert.equal(overridden.input?.modelChoice.thinkingLevel, "low");
});
