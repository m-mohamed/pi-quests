import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuest, getQuestPathsFromAgentDir, loadActiveQuest, saveQuest, writeWorkerRun } from "../src/state-core.js";

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

		const status = await runPi(agentDir, resolvedRepoDir, "/quest");
		assert(status.exitCode === 0, `status command failed: ${status.stderr}`);
		assert(status.stdout.includes("No active quest"), "extension did not respond to /quest");
		assert(!existsSync(join(agentDir, "quests")), "status should not create quest storage before a quest exists");

		const questList = await runPi(agentDir, resolvedRepoDir, "/quests");
		assert(questList.exitCode === 0, `quests list failed: ${questList.stderr}`);
		assert(questList.stdout.includes("No quests found"), "quests list did not return empty-project guidance");

		const enterQuest = await runPi(agentDir, resolvedRepoDir, "/enter-quest");
		assert(enterQuest.exitCode === 0, `enter-quest failed: ${enterQuest.stderr}`);
		assert(enterQuest.stdout.includes("Quest mode enabled"), "enter-quest did not acknowledge quest mode");

		const exitQuest = await runPi(agentDir, resolvedRepoDir, "/exit-quest");
		assert(exitQuest.exitCode === 0, `exit-quest failed: ${exitQuest.stderr}`);
		assert(exitQuest.stdout.includes("Quest mode disabled"), "exit-quest did not disable quest mode");

		const printRepoDir = join(sandbox, "print-repo");
		await mkdir(printRepoDir, { recursive: true });
		const resolvedPrintRepoDir = await realpath(printRepoDir);
		const printCreate = await runPi(agentDir, resolvedPrintRepoDir, "/quest new print-mode safety probe");
		assert(printCreate.exitCode === 0, `print-mode quest creation failed: ${printCreate.stderr}`);
		assert(printCreate.stdout.includes("Quest created"), "print-mode quest creation did not acknowledge the new quest");
		assert(
			printCreate.stdout.includes("non-interactive mode") ||
				printCreate.stdout.includes("Run another prompt") ||
				printCreate.stdout.includes("planning mode"),
			"print-mode quest creation did not explain the safe two-step planning flow",
		);
		const printQuest = await loadActiveQuest(agentDir, resolvedPrintRepoDir);
		assert(printQuest?.status === "planning", "print-mode quest creation did not persist a planning quest");

		const missingAbort = await runPi(agentDir, resolvedRepoDir, "/quest abort");
		assert(missingAbort.exitCode === 0, `abort without quest failed: ${missingAbort.stderr}`);
		assert(missingAbort.stdout.includes("No active quest to abort"), "abort without quest did not warn clearly");

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

		const redundantApprove = await runPi(agentDir, resolvedRepoDir, "/quest approve");
		assert(redundantApprove.exitCode === 0, `redundant approve failed: ${redundantApprove.stderr}`);
		assert(
			redundantApprove.stdout.includes("already approved") || redundantApprove.stdout.includes("not waiting on human QA approval"),
			"redundant approve did not stay bounded",
		);

		const listedQuest = await runPi(agentDir, resolvedRepoDir, "/quests");
		assert(listedQuest.exitCode === 0, `quest list after creation failed: ${listedQuest.stderr}`);
		assert(listedQuest.stdout.includes("finish the qa loop"), "quests list did not include the created quest title");
		assert(listedQuest.stdout.includes("completed"), "quests list did not include the quest status");

		const planningQuest = await createQuest(agentDir, resolvedRepoDir, "planning edge case", MODEL);
		const planningResume = await runPi(agentDir, resolvedRepoDir, "/quest resume");
		assert(planningResume.exitCode === 0, `resume from planning failed: ${planningResume.stderr}`);
		assert(
			planningResume.stdout.includes("Use /quest resume only for paused or aborted quests") ||
				planningResume.stdout.includes("Quest has no approved proposal yet"),
			"resume from planning did not enforce the command contract",
		);

		const planningAccept = await runPi(agentDir, resolvedRepoDir, "/quest accept");
		assert(planningAccept.exitCode === 0, `accept from planning failed: ${planningAccept.stderr}`);
		assert(
			planningAccept.stdout.includes("Use /quest accept only after the quest proposal reaches ready"),
			"accept from planning did not enforce the ready boundary",
		);

		planningQuest.status = "running";
		planningQuest.activeRun = {
			role: "worker",
			kind: "feature",
			featureId: "f-running",
			milestoneId: "m-running",
			phase: "streaming",
			startedAt: Date.now(),
			pid: process.pid,
		};
		await saveQuest(agentDir, planningQuest);

		const runningPause = await runPi(agentDir, resolvedRepoDir, "/quest pause");
		assert(runningPause.exitCode === 0, `pause during active run failed: ${runningPause.stderr}`);
		assert(runningPause.stdout.includes("Use /quest abort"), "pause during active run did not direct the operator to abort");

		const runningResume = await runPi(agentDir, resolvedRepoDir, "/quest resume");
		assert(runningResume.exitCode === 0, `resume during active run failed: ${runningResume.stderr}`);
		assert(runningResume.stdout.includes("already running"), "resume during active run did not enforce the running boundary");

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
