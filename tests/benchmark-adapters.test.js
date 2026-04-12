import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { evaluateHarborIntegrity } from "../src/harbor-integrity.js";
import { buildHarborCommand, bundledLinuxNodeArchitectures } from "../benchmarks/harbor/run.ts";
import { deriveNextSteps, inspectHarborSmokeJobs } from "../benchmarks/harbor/preflight.ts";
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
		authDir: null,
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

test("buildHarborCommand mounts the Pi auth directory instead of injecting provider tokens", async () => {
	const authDir = await mkdtemp(join(tmpdir(), "pi-quests-auth-"));
	try {
		const command = buildHarborCommand({
			dataset: "terminal-bench-sample@2.0",
			runMode: "smoke",
			model: "zai/glm-5.1",
			bundlePath: "/tmp/bundle",
			nodeRuntimePath: "/tmp/node-runtimes",
			authDir,
		});
		const mountsIndex = command.args.indexOf("--mounts-json");
		assert.notEqual(mountsIndex, -1);
		const mounts = JSON.parse(command.args[mountsIndex + 1]);
		assert.deepEqual(mounts, [
			"/tmp/bundle:/opt/quest-package:ro",
			"/tmp/node-runtimes:/opt/quest-node-runtimes:ro",
			`${authDir}:/root/.pi/agent`,
		]);
		assert.equal(command.args.includes("ZAI_API_KEY="), false);
		assert.equal(command.args.includes("OPENAI_API_KEY="), false);
		assert.equal(command.args.some((value) => value.startsWith("ZAI_API_KEY=")), false);
		assert.equal(command.args.some((value) => value.startsWith("OPENAI_API_KEY=")), false);
	} finally {
		await rm(authDir, { recursive: true, force: true });
	}
});

test("bundledLinuxNodeArchitectures defaults to both Linux runtimes and honors overrides", () => {
	const previous = process.env.PI_QUESTS_HARBOR_NODE_ARCHES;
	try {
		delete process.env.PI_QUESTS_HARBOR_NODE_ARCHES;
		assert.deepEqual(bundledLinuxNodeArchitectures(), ["x64", "arm64"]);

		process.env.PI_QUESTS_HARBOR_NODE_ARCHES = "arm64,x64,arm64,invalid";
		assert.deepEqual(bundledLinuxNodeArchitectures(), ["arm64", "x64"]);
	} finally {
		if (previous === undefined) delete process.env.PI_QUESTS_HARBOR_NODE_ARCHES;
		else process.env.PI_QUESTS_HARBOR_NODE_ARCHES = previous;
	}
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

test("inspectHarborSmokeJobs validates a completed smoke run with Quest JSON output", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-quests-harbor-preflight-"));
	const runDir = join(jobsDir, "2026-04-08__10-00-00");
	const trialDir = join(runDir, "regex-log__abc123", "agent");
	try {
		await mkdir(trialDir, { recursive: true });
		await writeFile(
			join(runDir, "result.json"),
			JSON.stringify({
				n_total_trials: 1,
				stats: { n_errors: 0 },
			}),
		);
		await writeFile(
			join(trialDir, "quest-headless-output.json"),
			JSON.stringify({
				status: "ok",
				data: {
					status: "completed",
				},
			}),
		);
		const result = await inspectHarborSmokeJobs(jobsDir, "sample/regex-log");
		assert.equal(result.ok, true);
		assert.match(result.detail, /sample\/regex-log/);
		assert.equal(result.jobDir, runDir);
		assert.equal(result.artifactPath, join(trialDir, "quest-headless-output.json"));
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("inspectHarborSmokeJobs includes the most relevant Harbor artifact tail on failure", async () => {
	const jobsDir = await mkdtemp(join(tmpdir(), "pi-quests-harbor-preflight-failure-"));
	const runDir = join(jobsDir, "2026-04-08__10-00-00");
	const trialDir = join(runDir, "qemu-startup__abc123", "agent");
	try {
		await mkdir(trialDir, { recursive: true });
		await writeFile(
			join(runDir, "result.json"),
			JSON.stringify({
				n_total_trials: 1,
				stats: { n_errors: 1 },
			}),
		);
		await writeFile(
			join(trialDir, "quest-headless-stderr.log"),
			[
				"some earlier noise",
				"Timed out waiting for login prompt",
				"still blocked on serial boot",
			].join("\n"),
		);
		const result = await inspectHarborSmokeJobs(jobsDir, "sample/qemu-startup");
		assert.equal(result.ok, false);
		assert.equal(result.jobDir, runDir);
		assert.equal(result.artifactPath, join(trialDir, "quest-headless-stderr.log"));
		assert.match(result.detail, /Job dir: /);
		assert.match(result.detail, /Artifact tail/);
		assert.match(result.detail, /Timed out waiting for login prompt/);
	} finally {
		await rm(jobsDir, { recursive: true, force: true });
	}
});

test("evaluateHarborIntegrity fails closed for shared verifier environments", () => {
	const report = evaluateHarborIntegrity({
		harborVersion: "1.0.0",
		trialExecuteAgentSource: "await self._agent.run(environment=self._environment, context=self.result.agent_result)",
		trialRunVerificationSource: "await self._verify_with_retry()",
		verifierVerifySource: [
			"await self._environment.upload_dir(",
			"    source_dir=self._task.paths.tests_dir,",
			'    target_dir="/tests",',
			")",
			"await self._environment.exec(command=f\"{test_script_path} > {test_stdout_path} 2>&1\")",
		].join("\n"),
	});
	assert.equal(report.ok, false);
	assert.deepEqual(report.issues.map((issue) => issue.code), [
		"shared_phase_environment",
		"mutable_system_state_survives_verification",
	]);
	assert.match(report.summary, /failed the local benchmark integrity probe/);
	assert.match(report.evidence.trialExecuteAgentSnippet ?? "", /environment=self\._environment/);
	assert.match(report.evidence.verifierVerifySnippet ?? "", /target_dir="\/tests"/);
	assert.match(report.evidence.verifierVerifySnippet ?? "", /self\._environment\.exec/);
});

test("deriveNextSteps treats an integrity-only failure as a trust blocker, not a smoke failure", () => {
	const steps = deriveNextSteps(
		[
			{
				name: "harbor-smoke",
				ok: true,
				detail: "smoke ok",
				jobDir: "/tmp/harbor-smoke-job",
				artifactPath: "/tmp/harbor-smoke-job/agent/quest-headless-output.json",
			},
			{
				name: "harbor-integrity",
				ok: false,
				detail: "integrity failed",
				context: {
					issueCodes: ["shared_phase_environment", "mutable_system_state_survives_verification"],
				},
			},
		],
		"regex-log",
		"/tmp/preflight-smoke",
		false,
	);
	assert.equal(steps.some((step) => /Fix the failed prerequisite checks/.test(step)), false);
	assert.equal(steps.some((step) => /Harbor smoke already succeeded/.test(step)), true);
	assert.equal(steps.some((step) => /shared_phase_environment, mutable_system_state_survives_verification/.test(step)), true);
	assert.equal(steps.some((step) => /Do not trust Terminal-Bench scores/.test(step)), true);
});
