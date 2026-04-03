import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuest, loadActiveQuest, saveQuest } from "../src/state-core.js";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = {
	provider: "openai-codex",
	model: "gpt-5.4",
	thinkingLevel: "high" as const,
};

async function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
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
		let finished = false;
		const timeout = setTimeout(() => {
			if (finished) return;
			stderr += `\nTimed out after ${options.timeoutMs ?? 30000}ms`;
			proc.kill("SIGTERM");
		}, options.timeoutMs ?? 30000);
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			finished = true;
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
		});
		proc.on("error", (error) => {
			finished = true;
			clearTimeout(timeout);
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
		assert(!existsSync(join(resolvedRepoDir, ".pi", "quests")), "status should not create quest storage before a quest exists");

		const questList = await runPi(agentDir, resolvedRepoDir, "/quests");
		assert(questList.exitCode === 0, `quests list failed: ${questList.stderr}`);
		assert(questList.stdout.includes("No quests found"), "quests list did not return empty-project guidance");

		const enterQuest = await runPi(agentDir, resolvedRepoDir, "/quest enter");
		assert(enterQuest.exitCode === 0, `enter-quest failed: ${enterQuest.stderr}`);
		assert(enterQuest.stdout.includes("Quest mode enabled"), "enter-quest did not acknowledge quest mode");

		const exitQuest = await runPi(agentDir, resolvedRepoDir, "/quest exit");
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
		const printQuest = await loadActiveQuest(resolvedPrintRepoDir);
		assert(printQuest?.status === "planning", "print-mode quest creation did not persist a planning quest");

		const missingAbort = await runPi(agentDir, resolvedRepoDir, "/quest abort");
		assert(missingAbort.exitCode === 0, `abort without quest failed: ${missingAbort.stderr}`);
		assert(missingAbort.stdout.includes("No active quest to abort"), "abort without quest did not warn clearly");

		const completedQuest = await createQuest(resolvedRepoDir, "finish the qa loop", MODEL);
		completedQuest.status = "completed";
		completedQuest.shipReadiness = "validated_waiting_for_human_qa";
		completedQuest.humanQaStatus = "pending";
		completedQuest.lastSummary = "Quest completed. Human QA is still required before shipping.";
		await saveQuest(completedQuest);

		const completedView = await runPi(agentDir, resolvedRepoDir, "/quest");
		assert(completedView.exitCode === 0, `completed quest summary failed: ${completedView.stderr}`);
		assert(
			completedView.stdout.includes("Quest completed. Human QA is still required before shipping."),
			"completed quest summary did not preserve the explicit human QA handoff",
		);
		assert(completedView.stdout.includes("Human QA checklist:"), "completed quest summary did not include the human QA checklist");

		const persistedCompletedQuest = await loadActiveQuest(resolvedRepoDir);
		assert(persistedCompletedQuest?.humanQaStatus === "pending", "completed quest should still require human QA");
		assert(
			persistedCompletedQuest?.shipReadiness === "validated_waiting_for_human_qa",
			"completed quest should remain validation-complete but not human-approved",
		);

		const listedQuest = await runPi(agentDir, resolvedRepoDir, "/quests");
		assert(listedQuest.exitCode === 0, `quest list after creation failed: ${listedQuest.stderr}`);
		assert(listedQuest.stdout.includes("finish the qa loop"), "quests list did not include the created quest title");
		assert(listedQuest.stdout.includes("completed"), "quests list did not include the quest status");

		const planningQuest = await createQuest(resolvedRepoDir, "planning edge case", MODEL);
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
			planningAccept.stdout.includes("Use /quest accept only after the quest proposal reaches proposal_ready."),
			"accept from planning did not enforce the proposal-ready boundary",
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
		await saveQuest(planningQuest);

		const runningPause = await runPi(agentDir, resolvedRepoDir, "/quest pause");
		assert(runningPause.exitCode === 0, `pause during active run failed: ${runningPause.stderr}`);
		assert(runningPause.stdout.includes("Use /quest abort"), "pause during active run did not direct the operator to abort");

		const runningResume = await runPi(agentDir, resolvedRepoDir, "/quest resume");
		assert(runningResume.exitCode === 0, `resume during active run failed: ${runningResume.stderr}`);
		assert(runningResume.stdout.includes("already running"), "resume during active run did not enforce the running boundary");

		console.log("smoke ok");
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

await main();
