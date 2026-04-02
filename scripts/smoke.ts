import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuest, getQuestPathsFromAgentDir, saveQuest, writeWorkerRun } from "../src/state-core.js";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high" as const,
};

async function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return await new Promise((resolvePromise) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
		});
		proc.on("error", (error) => {
			resolvePromise({ stdout, stderr: `${stderr}\n${error}`, exitCode: 1 });
		});
	});
}

async function runPi(agentDir: string, cwd: string, prompt: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return runCommand("pi", ["--no-session", "--mode", "json", "-p", prompt], {
		cwd,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
		},
	});
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main() {
	const sandbox = await mkdtemp(join(tmpdir(), "pi-quests-smoke-"));
	const agentDir = join(sandbox, "agent");
	const repoDir = join(sandbox, "repo");
	const extensionLinkDir = join(agentDir, "extensions");
	const linkedExtensionDir = join(extensionLinkDir, "pi-quests");

	try {
		await mkdir(extensionLinkDir, { recursive: true });
		await mkdir(repoDir, { recursive: true });
		const resolvedRepoDir = await realpath(repoDir);
		await writeFile(join(agentDir, "settings.json"), "{}\n", "utf-8");
		await symlink(extensionDir, linkedExtensionDir, "dir");
		await access(linkedExtensionDir);

		const version = await runCommand("pi", ["--version"]);
		const versionText = `${version.stdout}\n${version.stderr}`;
		assert(version.exitCode === 0, `pi --version failed: ${version.stderr}`);
		assert(/0\.64\.\d+/.test(versionText), `expected Pi 0.64.x for this extension, got: ${versionText.trim()}`);

		const status = await runPi(agentDir, resolvedRepoDir, "/quest status");
		assert(status.exitCode === 0, `status command failed: ${status.stderr}`);
		assert(status.stdout.includes("No active quest"), "extension did not respond to /quest status");
		assert(!existsSync(join(agentDir, "quests")), "status should not create quest storage before a quest exists");

		const legacyStatus = await runPi(agentDir, resolvedRepoDir, "/mission status");
		assert(legacyStatus.exitCode === 0, `legacy mission status command failed: ${legacyStatus.stderr}`);
		assert(legacyStatus.stdout.includes("No active quest"), "legacy /mission alias did not route to the quest status surface");

		const approvedQuest = await createQuest(agentDir, resolvedRepoDir, "finish the qa loop", MODEL);
		approvedQuest.status = "completed";
		approvedQuest.shipReadiness = "validated_waiting_for_human_qa";
		approvedQuest.humanQaStatus = "pending";
		await saveQuest(agentDir, approvedQuest);

		const approve = await runPi(agentDir, resolvedRepoDir, "/quest approve");
		assert(approve.exitCode === 0, `approve command failed: ${approve.stderr}`);
		assert(approve.stdout.includes("Human QA approved"), "extension did not respond to /quest approve");

		const approvedPaths = getQuestPathsFromAgentDir(agentDir, resolvedRepoDir, approvedQuest.id);
		const approvedPersistedQuest = JSON.parse(await Bun.file(approvedPaths.questFile).text());
		assert(approvedPersistedQuest.humanQaStatus === "approved", "approve did not persist human QA status");
		assert(approvedPersistedQuest.shipReadiness === "human_qa_complete", "approve did not persist ship readiness");

		const quest = await createQuest(agentDir, resolvedRepoDir, "prune old runtime logs", MODEL);
		quest.status = "completed";
		await saveQuest(agentDir, quest);
		const paths = getQuestPathsFromAgentDir(agentDir, resolvedRepoDir, quest.id);
		const persistedQuest = JSON.parse(await Bun.file(paths.questFile).text());
		persistedQuest.updatedAt = Date.now() - 1000 * 60 * 60 * 24 * 30;
		await writeFile(paths.questFile, `${JSON.stringify(persistedQuest, null, 2)}\n`, "utf-8");
		await writeWorkerRun(agentDir, resolvedRepoDir, quest.id, {
			id: "smoke-run",
			role: "validator",
			milestoneId: "m1",
			startedAt: Date.now() - 2000,
			endedAt: Date.now() - 1000,
			provider: MODEL.provider,
			model: MODEL.model,
			thinkingLevel: MODEL.thinkingLevel,
			exitCode: 0,
			ok: true,
			summary: "validated milestone",
			phase: "completed",
			events: [],
		});
		await writeFile(paths.eventsFile, '{"type":"synthetic"}\n', "utf-8");
		assert(existsSync(paths.eventsFile), "failed to seed synthetic event log");

		const prune = await runPi(agentDir, resolvedRepoDir, "/quest prune");
		assert(prune.exitCode === 0, `prune command failed: ${prune.stderr}`);
		assert(prune.stdout.includes("Pruned quest runtime logs"), "extension did not respond to /quest prune");
		assert(prune.stdout.includes("validation contracts"), "prune output did not confirm retained metadata");
		assert(!existsSync(paths.eventsFile), "prune did not remove the old event log");
		assert(!existsSync(paths.workersDir), "prune did not remove the old worker runs");

		console.log("smoke ok");
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

await main();
