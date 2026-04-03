import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildHarborCommand } from "../benchmarks/harbor/run.ts";
import { runSlopCodeBenchDataset } from "../benchmarks/slopcodebench/run.ts";

const DEFAULT_MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high",
};

test("buildHarborCommand wires the Quest installed-agent adapter", () => {
	const command = buildHarborCommand({
		dataset: "terminal-bench-sample@2.0",
		runMode: "sample",
		model: "openai-codex/gpt-5.4",
		bundlePath: "/tmp",
	});
	assert.equal(command.command, "harbor");
	assert.ok(command.args.includes("--yes"));
	assert.ok(command.args.includes("--agent-import-path"));
	assert.ok(command.args.includes("benchmarks.harbor.quest_installed_agent:QuestInstalledAgent"));
	assert.ok(command.args.includes("-n"));
	assert.ok(command.args.includes("1"));
	assert.ok(command.args.includes("--agent-setup-timeout-multiplier"));
	assert.ok(command.args.includes("4"));
	assert.ok(command.args.includes("--mounts-json"));
	assert.ok(command.args.includes("[\"/tmp:/opt/quest-package:ro\"]"));
	assert.ok(command.args.includes("--ae"));
	assert.ok(command.args.includes("QUEST_PACKAGE_DIR=/opt/quest-package"));
	assert.ok(command.args.includes("QUEST_HARBOR_DATASET=terminal-bench-sample@2.0"));
	assert.ok(command.args.includes("QUEST_HARBOR_RUN_MODE=sample"));
	assert.equal(command.env.QUEST_HARBOR_DATASET, "terminal-bench-sample@2.0");
	assert.equal(command.env.QUEST_HARBOR_RUN_MODE, "sample");
});

test("runSlopCodeBenchDataset maps one checkpoint to one headless Quest run", async () => {
	const calls = [];
	const datasetPath = resolve("/Users/mohamedmohamed/research/pi-quests/benchmarks/slopcodebench/smoke-dataset.json");
	const results = await runSlopCodeBenchDataset(datasetPath, "smoke", DEFAULT_MODEL, async (input) => {
		calls.push(input);
		return {
			status: "proposal_ready",
			summary: "dry-run checkpoint",
			questId: `${input.benchmark?.taskId}-${input.benchmark?.checkpointId}`,
			profileId: "repo-test",
			traceBundleIds: [],
			validatorFindings: [],
			artifactPaths: { result: "/tmp/headless.json" },
			benchmark: {
				...input.benchmark,
				recordedAt: Date.now(),
				model: "openai-codex/gpt-5.4:high",
			},
		};
	});
	assert.equal(results.length, 2);
	assert.equal(calls.length, 2);
	assert.ok(calls.every((call) => call.benchmark?.benchmark === "slopcodebench"));
	assert.ok(calls.every((call) => call.cwd !== resolve("/Users/mohamedmohamed/research/pi-quests/benchmarks/slopcodebench/fixtures/mini-cli")));
	assert.ok(calls.every((call) => call.cwd.includes("quest-slopcodebench-trajectory-api-")));
	assert.ok(calls.every((call) => call.cwd.endsWith("/mini-cli")));
	assert.equal(calls[0].benchmark?.checkpointId, "checkpoint-1");
	assert.equal(calls[1].benchmark?.checkpointId, "checkpoint-2");
});
