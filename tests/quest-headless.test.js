import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, usage } from "../src/quest-headless.js";

test("quest-headless keeps high thinking for non-benchmark runs by default", async () => {
	const parsed = await parseArgs(["run", "--instruction", "Solve the repo task"]);
	assert.equal(parsed.command, "run");
	assert.equal(parsed.input?.modelChoice.provider, "zai");
	assert.equal(parsed.input?.modelChoice.model, "glm-5.1");
	assert.equal(parsed.input?.modelChoice.thinkingLevel, "high");
});

test("quest-headless keeps benchmark flags behind internal mode", async () => {
	await assert.rejects(
		() =>
			parseArgs([
				"run",
				"--instruction",
				"Solve the benchmark task",
				"--benchmark",
				"terminal-bench",
				"--dataset",
				"terminal-bench-sample@2.0",
				"--task-id",
				"chess-best-move",
			]),
		/internal|maintainer-only/i,
	);

	const previous = process.env.PI_QUESTS_INTERNAL;
	process.env.PI_QUESTS_INTERNAL = "1";
	try {
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
		assert.equal(benchmark.input?.modelChoice.thinkingLevel, "low");

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
	} finally {
		if (previous === undefined) delete process.env.PI_QUESTS_INTERNAL;
		else process.env.PI_QUESTS_INTERNAL = previous;
	}
});

test("usage adapts to the invoked binary name", () => {
	const help = usage("quest-headless");
	assert.match(help, /^Usage:\n  quest-headless run/m);
	assert.doesNotMatch(help, /mission/i);
	assert.doesNotMatch(help, /--benchmark/);
});
