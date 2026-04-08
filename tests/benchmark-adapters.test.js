import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildHarborCommand } from "../benchmarks/harbor/run.ts";
import { buildOfficialSlopCodeBenchCommand, resolveSlopCodeBenchRepo } from "../benchmarks/slopcodebench/official-run.ts";

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
		nodeRuntimePath: "/tmp/node-runtimes",
		profileId: "repo-project-candidate-001",
		includeTaskNames: ["sample/chess-best-move", "sample/regex-log"],
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
	assert.ok(
		command.args.includes("[\"/tmp:/opt/quest-package:ro\",\"/tmp/node-runtimes:/opt/quest-node-runtimes:ro\"]"),
	);
	assert.ok(command.args.includes("--ae"));
	assert.ok(command.args.includes("QUEST_PACKAGE_DIR=/opt/quest-package"));
	assert.ok(command.args.includes("QUEST_NODE_RUNTIME_DIR=/opt/quest-node-runtimes"));
	assert.ok(command.args.includes("PI_QUESTS_PI_BIN=/opt/quest-package/node_modules/.bin/pi"));
	assert.ok(command.args.includes("QUEST_HARBOR_DATASET=terminal-bench-sample@2.0"));
	assert.ok(command.args.includes("QUEST_HARBOR_RUN_MODE=sample"));
	assert.ok(command.args.includes("QUEST_HARBOR_PROFILE_ID=repo-project-candidate-001"));
	assert.equal(command.args.filter((value) => value === "--include-task-name").length, 2);
	assert.ok(command.args.includes("sample/chess-best-move"));
	assert.ok(command.args.includes("sample/regex-log"));
	assert.equal(command.env.QUEST_HARBOR_DATASET, "terminal-bench-sample@2.0");
	assert.equal(command.env.QUEST_HARBOR_RUN_MODE, "sample");
});

test("buildOfficialSlopCodeBenchCommand supports repeated problems and stable output roots", () => {
	const command = buildOfficialSlopCodeBenchCommand({
		repo: "/tmp/slop-code-bench",
		problems: ["trajectory-api", "workflow-shell"],
		model: `${DEFAULT_MODEL.provider}/${DEFAULT_MODEL.model}`,
		environment: "local-py",
		dryRun: true,
		outputDir: "/tmp/slop-official-output",
	});
	assert.equal(command.command, "uv");
	assert.equal(command.cwd, "/tmp/slop-code-bench");
	assert.equal(command.args.filter((value) => value === "--problem").length, 2);
	assert.ok(command.args.includes("trajectory-api"));
	assert.ok(command.args.includes("workflow-shell"));
	assert.ok(command.args.includes("save_dir=/tmp/slop-official-output"));
	assert.ok(command.args.includes("--dry-run"));
	assert.match(command.env.PYTHONPATH ?? "", /benchmarks\/slopcodebench\/official-overlay/);
	assert.match(command.env.SLOPCODEBENCH_QUEST_BIN ?? "", /bin\/quest-headless\.mjs$/);
});

test("resolveSlopCodeBenchRepo prefers explicit repo over environment fallback", async () => {
	const envRepo = await mkdtemp(join(tmpdir(), "pi-quests-slop-env-"));
	const explicitRepo = await mkdtemp(join(tmpdir(), "pi-quests-slop-explicit-"));
	const previous = process.env.SLOPCODEBENCH_REPO;
	try {
		process.env.SLOPCODEBENCH_REPO = envRepo;
		assert.equal(resolveSlopCodeBenchRepo(explicitRepo), explicitRepo);
		assert.equal(resolveSlopCodeBenchRepo(undefined), envRepo);
	} finally {
		if (previous === undefined) delete process.env.SLOPCODEBENCH_REPO;
		else process.env.SLOPCODEBENCH_REPO = previous;
		await rm(envRepo, { recursive: true, force: true });
		await rm(explicitRepo, { recursive: true, force: true });
	}
});
