import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, usage } from "../src/quest-headless.js";

test("quest-headless keeps high thinking for non-eval runs by default", async () => {
	const parsed = await parseArgs(["run", "--instruction", "Solve the repo task"]);
	assert.equal(parsed.command, "run");
	assert.equal(parsed.input?.modelChoice.provider, "zai");
	assert.equal(parsed.input?.modelChoice.model, "glm-5.1");
	assert.equal(parsed.input?.modelChoice.thinkingLevel, "high");
});

test("quest-headless keeps eval flags behind internal mode", async () => {
	await assert.rejects(
		() =>
			parseArgs([
				"run",
				"--instruction",
				"Solve the eval task",
				"--eval",
				"frontierswe",
				"--suite",
				"frontierswe-sample@v1",
				"--task-id",
				"update-api-port",
			]),
		/internal|maintainer-only/i,
	);

	const previous = process.env.PI_QUESTS_INTERNAL;
	process.env.PI_QUESTS_INTERNAL = "1";
	try {
		const sample = await parseArgs([
			"run",
			"--instruction",
			"Solve the eval task",
			"--eval",
			"frontierswe",
			"--suite",
			"frontierswe-sample@v1",
			"--task-id",
			"update-api-port",
			"--run-mode",
			"sample",
		]);
		assert.equal(sample.input?.modelChoice.thinkingLevel, "low");
		assert.equal(sample.internalInput?.evaluation?.name, "frontierswe");

		const full = await parseArgs([
			"run",
			"--instruction",
			"Solve the eval task",
			"--eval",
			"frontierswe",
			"--suite",
			"frontierswe@public-v1",
			"--task-id",
			"update-api-port",
			"--run-mode",
			"full",
		]);
		assert.equal(full.input?.modelChoice.thinkingLevel, "medium");
	} finally {
		if (previous === undefined) delete process.env.PI_QUESTS_INTERNAL;
		else process.env.PI_QUESTS_INTERNAL = previous;
	}
});

test("quest-headless rejects unknown flags", async () => {
	await assert.rejects(
		() => parseArgs(["run", "--instruction", "legacy", "--unknown-flag"]),
		/Unknown argument: --unknown-flag/,
	);
});

test("usage adapts to the invoked binary name", () => {
	const help = usage("quest-headless");
	assert.match(help, /^Usage:\n  quest-headless run/m);
	assert.doesNotMatch(help, /mission/i);
	assert.match(help, /--json\s+Print machine-readable JSON to stdout/);
});
