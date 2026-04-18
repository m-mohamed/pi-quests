import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { detectLinuxNodeArch, materializeQuestBundle } from "./docker-eval-runtime.js";
import type {
	ModelChoice,
	QuestCandidateScorecard,
	QuestCandidateTagMetrics,
	QuestCandidateWorkItemResult,
	QuestEvalManifest,
	QuestEvalRunMode,
	QuestEvalSplit,
	QuestEvalWorkItem,
} from "./types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTIERSWE_SAMPLE_DATASET = "frontierswe-sample@v1";
const FRONTIERSWE_PUBLIC_DATASET = "frontierswe@public-v1";

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface FrontiersweTaskDefinition {
	id: string;
	taskDir: string;
	instructionFile: string;
	dockerImage: string;
	timeoutSec: number;
	verifierTimeoutSec: number;
	buildTimeoutSec: number;
	category?: string;
	difficulty?: string;
	tags: string[];
	hasRewardScript: boolean;
	metadata: Record<string, unknown>;
}

interface CommandOptions {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs?: number;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface QuestHeadlessEnvelope {
	data?: {
		status?: string;
		summary?: string;
		failureCategory?: string;
		timeoutReason?: string;
		executionFindings?: string[];
		validatorFindings?: string[];
		artifactPaths?: Record<string, string>;
		evaluation?: {
			name?: string;
			dataset?: string;
			taskId?: string;
			checkpointId?: string;
			runMode?: QuestEvalRunMode;
			adapterVersion?: string;
			recordedAt?: number;
			model?: string;
			passed?: boolean;
			score?: number;
		};
	};
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultFrontiersweSampleRoot(): string {
	return resolve(PACKAGE_ROOT, "evals", "frontierswe", "sample-tasks");
}

function summarizeTags(items: QuestEvalWorkItem[]): Record<string, number> {
	const summary: Record<string, number> = {};
	for (const item of items) {
		for (const tag of item.tags) summary[tag] = (summary[tag] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])));
}

function buildTagBreakdown(results: QuestCandidateWorkItemResult[]): Record<string, QuestCandidateTagMetrics> {
	const breakdown = new Map<string, { itemCount: number; passed: number; totalScore: number; totalCost: number; totalDurationMs: number }>();
	for (const result of results) {
		const tags = Array.isArray(result.evalMetrics?.workItemTags) ? (result.evalMetrics.workItemTags as string[]) : [];
		for (const tag of tags) {
			const bucket = breakdown.get(tag) ?? {
				itemCount: 0,
				passed: 0,
				totalScore: 0,
				totalCost: 0,
				totalDurationMs: 0,
			};
			bucket.itemCount += 1;
			if (result.status === "passed") bucket.passed += 1;
			bucket.totalScore += result.score;
			bucket.totalCost += result.totalCost;
			bucket.totalDurationMs += result.durationMs;
			breakdown.set(tag, bucket);
		}
	}
	return Object.fromEntries(
		[...breakdown.entries()].map(([tag, metrics]) => [
			tag,
			{
				...metrics,
				meanScore: metrics.itemCount > 0 ? metrics.totalScore / metrics.itemCount : 0,
			},
		]),
	);
}

async function runCommandCapture(options: CommandOptions): Promise<CommandResult> {
	return new Promise<CommandResult>((resolvePromise, reject) => {
		const proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("error", reject);
		proc.on("spawn", () => {
			if (options.onProcessStart) {
				void Promise.resolve(options.onProcessStart(proc.pid ?? 0));
			}
		});
		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				proc.kill("SIGTERM");
			}, options.timeoutMs);
		}
		proc.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolvePromise({
				exitCode: code ?? 1,
				stdout,
				stderr,
			});
		});
	});
}

async function ensureDockerImage(task: FrontiersweTaskDefinition): Promise<void> {
	const inspect = await runCommandCapture({
		command: "docker",
		args: ["image", "inspect", task.dockerImage],
		cwd: task.taskDir,
	});
	if (inspect.exitCode === 0) return;
	const environmentDir = join(task.taskDir, "environment");
	if (existsSync(join(environmentDir, "Dockerfile"))) {
		const built = await runCommandCapture({
			command: "docker",
			args: ["build", "-t", task.dockerImage, "-f", join(environmentDir, "Dockerfile"), task.taskDir],
			cwd: task.taskDir,
			timeoutMs: task.buildTimeoutSec * 1000,
		});
		if (built.exitCode === 0) return;
		throw new Error(`Failed to build Docker image ${task.dockerImage}.\n${built.stderr || built.stdout}`);
	}
	const pulled = await runCommandCapture({
		command: "docker",
		args: ["pull", task.dockerImage],
		cwd: task.taskDir,
		timeoutMs: task.buildTimeoutSec * 1000,
	});
	if (pulled.exitCode !== 0) {
		throw new Error(`Failed to pull Docker image ${task.dockerImage}.\n${pulled.stderr || pulled.stdout}`);
	}
}

async function copyWorkspaceFromImage(task: FrontiersweTaskDefinition, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	const create = await runCommandCapture({
		command: "docker",
		args: ["create", task.dockerImage],
		cwd: task.taskDir,
	});
	if (create.exitCode !== 0) {
		throw new Error(`Failed to create container from ${task.dockerImage}.\n${create.stderr || create.stdout}`);
	}
	const containerId = create.stdout.trim();
	try {
		const copy = await runCommandCapture({
			command: "docker",
			args: ["cp", `${containerId}:/app/.`, destination],
			cwd: task.taskDir,
			timeoutMs: task.buildTimeoutSec * 1000,
		});
		if (copy.exitCode !== 0) {
			throw new Error(`Failed to copy /app from ${task.dockerImage}.\n${copy.stderr || copy.stdout}`);
		}
	} finally {
		await runCommandCapture({
			command: "docker",
			args: ["rm", "-f", containerId],
			cwd: task.taskDir,
		});
	}
}

function normalizeTags(taskId: string, tags: string[], category?: string, difficulty?: string): string[] {
	const next = new Set<string>(["frontierswe", ...tags]);
	if (category) next.add(category.toLowerCase());
	if (difficulty) next.add(`difficulty:${difficulty.toLowerCase()}`);
	if (/(perf|optimization|opt)/i.test(taskId)) next.add("optimization");
	if (/(compiler|build|type|sql|inference|rl|video|git|notebook)/i.test(taskId)) next.add(taskId.split("-")[0] ?? taskId);
	return [...next];
}

async function loadTaskDefinition(taskDir: string): Promise<FrontiersweTaskDefinition> {
	const taskId = basename(taskDir);
	const taskToml = parseToml(await readFile(join(taskDir, "task.toml"), "utf-8")) as Record<string, any>;
	const metadata = (taskToml.metadata ?? {}) as Record<string, unknown>;
	const environment = (taskToml.environment ?? {}) as Record<string, unknown>;
	const agent = (taskToml.agent ?? {}) as Record<string, unknown>;
	const verifier = (taskToml.verifier ?? {}) as Record<string, unknown>;
	const tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
	return {
		id: taskId,
		taskDir,
		instructionFile: join(taskDir, "instruction.md"),
		dockerImage: String(environment.docker_image ?? `pi-quests/frontierswe-${taskId}:v1`),
		timeoutSec: Number(agent.timeout_sec ?? 1800),
		verifierTimeoutSec: Number(verifier.timeout_sec ?? 600),
		buildTimeoutSec: Number(environment.build_timeout_sec ?? 900),
		category: typeof metadata.category === "string" ? metadata.category : undefined,
		difficulty: typeof metadata.difficulty === "string" ? metadata.difficulty : undefined,
		tags: normalizeTags(taskId, tags, typeof metadata.category === "string" ? metadata.category : undefined, typeof metadata.difficulty === "string" ? metadata.difficulty : undefined),
		hasRewardScript: existsSync(join(taskDir, "tests", "compute_reward.py")),
		metadata: {
			timeoutSec: Number(agent.timeout_sec ?? 1800),
			verifierTimeoutSec: Number(verifier.timeout_sec ?? 600),
			dockerImage: String(environment.docker_image ?? `pi-quests/frontierswe-${taskId}:v1`),
			category: metadata.category,
			difficulty: metadata.difficulty,
		},
	};
}

async function discoverTaskDirs(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name))
		.sort((left, right) => left.localeCompare(right));
}

export function defaultFrontiersweDataset(): string {
	return FRONTIERSWE_SAMPLE_DATASET;
}

export function resolveFrontiersweRunMode(dataset: string, requested?: QuestEvalRunMode): QuestEvalRunMode {
	if (requested) return requested;
	if (dataset === FRONTIERSWE_SAMPLE_DATASET) return "sample";
	if (dataset === FRONTIERSWE_PUBLIC_DATASET) return "full";
	return "custom";
}

export async function discoverFrontiersweManifest(options: {
	dataset: string;
	runMode: QuestEvalRunMode;
	repo?: string;
	now?: number;
}): Promise<QuestEvalManifest> {
	const createdAt = options.now ?? Date.now();
	const taskRoot =
		options.dataset === FRONTIERSWE_SAMPLE_DATASET
			? defaultFrontiersweSampleRoot()
			: options.repo
				? resolve(options.repo, "tasks")
				: null;
	if (!taskRoot) {
		throw new Error(`FrontierSWE dataset ${options.dataset} requires --repo <frontier-swe checkout>.`);
	}
	if (!existsSync(taskRoot)) {
		throw new Error(`FrontierSWE task root does not exist: ${taskRoot}`);
	}
	const taskDirs = await discoverTaskDirs(taskRoot);
	const definitions = await Promise.all(taskDirs.map((taskDir) => loadTaskDefinition(taskDir)));
	const items: QuestEvalWorkItem[] = definitions.map((task) => ({
		id: task.id,
		name: task.id,
		family: "frontierswe",
		dataset: options.dataset,
		path: task.taskDir,
		tags: task.tags,
		metadata: { ...task.metadata, runMode: options.runMode },
	}));
	return {
		id: options.dataset,
		family: "frontierswe",
		dataset: options.dataset,
		runMode: options.runMode,
		createdAt,
		totalItems: items.length,
		source: options.dataset === FRONTIERSWE_SAMPLE_DATASET ? "vendored" : "discovered",
		sourceFingerprint: `frontierswe:${options.dataset}:${items.map((item) => item.id).join(",")}`,
		items,
		tagSummary: summarizeTags(items),
		notes: [
			options.dataset === FRONTIERSWE_SAMPLE_DATASET
				? "Vendored FrontierSWE sample tasks."
				: `Discovered from ${resolve(options.repo ?? ".", "tasks")}.`,
		],
	};
}

async function writeArtifact(file: string, payload: string): Promise<string> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, payload, "utf-8");
	return file;
}

async function runAgentPhase(input: {
	task: FrontiersweTaskDefinition;
	workspaceDir: string;
	logDir: string;
	profileId: string;
	dataset: string;
	runMode: QuestEvalRunMode;
	bundle: Awaited<ReturnType<typeof materializeQuestBundle>>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<{ stdout: string; stderr: string; outputFile: string; parsed: QuestHeadlessEnvelope | null }> {
	await mkdir(input.logDir, { recursive: true });
	const nodeRuntimeDir = join(input.bundle.nodeRuntimeRoot, `node-linux-${detectLinuxNodeArch()}`);
	const args = [
		"run",
		"--rm",
		"--entrypoint",
		"/bin/bash",
		"-v",
		`${input.workspaceDir}:/app`,
		"-v",
		`${input.task.taskDir}/instruction.md:/opt/frontierswe/instruction.md:ro`,
		"-v",
		`${input.bundle.bundlePath}:/opt/quest-package:ro`,
		"-v",
		`${nodeRuntimeDir}:/opt/quest-node:ro`,
		"-v",
		`${input.logDir}:/logs/agent`,
	];
	if (input.bundle.authDir) {
		args.push("-v", `${input.bundle.authDir}:/root/.pi/agent:ro`);
	}
	const headlessCommand = [
		"/opt/quest-node/bin/node /opt/quest-package/dist/quest-headless.js run",
		"--instruction-file /opt/frontierswe/instruction.md",
		"--cwd /app",
		`--profile ${input.profileId}`,
		"--eval frontierswe",
		`--suite ${input.dataset}`,
		`--task-id ${input.task.id}`,
		`--run-mode ${input.runMode}`,
		"--json",
	].join(" ");
	args.push(
		input.task.dockerImage,
		"-lc",
		[
			"export PATH=/opt/quest-node/bin:$PATH",
			"export NODE_PATH=/opt/quest-package/node_modules",
			"export PI_QUESTS_INTERNAL=1",
			headlessCommand,
		].join(" && "),
	);
	const result = await runCommandCapture({
		command: "docker",
		args,
		cwd: input.task.taskDir,
		timeoutMs: input.task.timeoutSec * 1000,
		onProcessStart: input.onProcessStart,
	});
	const stdoutFile = await writeArtifact(join(input.logDir, "quest-headless.stdout"), result.stdout);
	const stderrFile = await writeArtifact(join(input.logDir, "quest-headless.stderr"), result.stderr);
	const outputFile = await writeArtifact(join(input.logDir, "quest-headless-output.json"), result.stdout);
	let parsed: QuestHeadlessEnvelope | null = null;
	try {
		parsed = JSON.parse(result.stdout) as QuestHeadlessEnvelope;
	} catch {
		parsed = null;
	}
	await writeArtifact(join(input.logDir, "artifacts.json"), jsonWithNewline({ stdoutFile, stderrFile, outputFile }));
	return { stdout: result.stdout, stderr: result.stderr, outputFile, parsed };
}

async function runVerifierPhase(input: {
	task: FrontiersweTaskDefinition;
	workspaceDir: string;
	logDir: string;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<CommandResult> {
	await mkdir(input.logDir, { recursive: true });
	const testsDir = join(input.task.taskDir, "tests");
	return runCommandCapture({
		command: "docker",
		args: [
			"run",
			"--rm",
			"--entrypoint",
			"/bin/bash",
			"-v",
			`${input.workspaceDir}:/app`,
			"-v",
			`${testsDir}:/tests:ro`,
			"-v",
			`${input.logDir}:/logs/verifier`,
			input.task.dockerImage,
			"-lc",
			[
				"set -e",
				"mkdir -p /logs/verifier",
				"test_rc=0",
				"/bin/bash /tests/test.sh > /logs/verifier/test.stdout 2> /logs/verifier/test.stderr || test_rc=$?",
				"if [ -f /tests/compute_reward.py ] && [ ! -f /logs/verifier/reward.json ]; then python3 /tests/compute_reward.py --output-dir /logs/verifier > /logs/verifier/compute_reward.stdout 2> /logs/verifier/compute_reward.stderr || true; fi",
				"exit $test_rc",
			].join("; "),
		],
		cwd: input.task.taskDir,
		timeoutMs: input.task.verifierTimeoutSec * 1000,
		onProcessStart: input.onProcessStart,
	});
}

async function readReward(logDir: string): Promise<{ score: number; maxScore: number }> {
	const rewardJson = join(logDir, "reward.json");
	if (existsSync(rewardJson)) {
		try {
			const payload = JSON.parse(await readFile(rewardJson, "utf-8")) as { reward?: number; score?: number };
			const score = Number(payload.reward ?? payload.score ?? 0);
			return { score, maxScore: Math.max(1, score) };
		} catch {
			// fall through
		}
	}
	const rewardTxt = join(logDir, "reward.txt");
	if (existsSync(rewardTxt)) {
		const parsed = Number((await readFile(rewardTxt, "utf-8")).trim());
		if (Number.isFinite(parsed)) return { score: parsed, maxScore: Math.max(1, parsed) };
	}
	return { score: 0, maxScore: 1 };
}

export async function runFrontiersweSplit(options: {
	cwd: string;
	modelChoice: ModelChoice;
	profileId: string;
	split: QuestEvalSplit;
	candidateId: string;
	repo?: string;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<QuestCandidateScorecard> {
	const bundle = await materializeQuestBundle(PACKAGE_ROOT);
	const results: QuestCandidateWorkItemResult[] = [];
	try {
		for (const item of options.split.items) {
			if (!item.path) {
				throw new Error(`FrontierSWE work item ${item.id} is missing its task path.`);
			}
			const task = await loadTaskDefinition(item.path);
			await ensureDockerImage(task);
			const trialDir = join(options.cwd, ".pi", "quests", "trials", "candidates", options.candidateId, "evals", options.split.split, item.id);
			const agentWorkspace = join(trialDir, "agent-workspace");
			await rm(trialDir, { recursive: true, force: true });
			await mkdir(trialDir, { recursive: true });
			await copyWorkspaceFromImage(task, agentWorkspace);
			const startedAt = Date.now();
			const agent = await runAgentPhase({
				task,
				workspaceDir: agentWorkspace,
				logDir: join(trialDir, "agent"),
				profileId: options.profileId,
				dataset: options.split.dataset,
				runMode: options.split.dataset === FRONTIERSWE_SAMPLE_DATASET ? "sample" : "full",
				bundle,
				onProcessStart: options.onProcessStart,
			});
			const verifierWorkspace = join(trialDir, "verifier-workspace");
			await cp(agentWorkspace, verifierWorkspace, { recursive: true });
			const verifier = await runVerifierPhase({
				task,
				workspaceDir: verifierWorkspace,
				logDir: join(trialDir, "verifier"),
				onProcessStart: options.onProcessStart,
			});
			const reward = await readReward(join(trialDir, "verifier"));
			const durationMs = Date.now() - startedAt;
			const failureText = [agent.parsed?.data?.summary ?? "", agent.parsed?.data?.timeoutReason ?? "", verifier.stderr].join(" ").trim();
			const score = reward.score;
			const status =
				verifier.exitCode === 0
					? score > 0
						? "passed"
						: "failed"
					: "error";
			results.push({
				itemId: item.id,
				itemName: item.name,
				family: options.split.family,
				dataset: options.split.dataset,
				split: options.split.split,
				status,
				score,
				maxScore: reward.maxScore,
				durationMs,
				totalCost: 0,
				modelChoice: `${options.modelChoice.provider}/${options.modelChoice.model}:${options.modelChoice.thinkingLevel}`,
				trialDir,
				questOutputFile: agent.outputFile,
				artifactPaths: [
					agent.outputFile,
					join(trialDir, "agent", "quest-headless.stdout"),
					join(trialDir, "agent", "quest-headless.stderr"),
					join(trialDir, "verifier", "test.stdout"),
					join(trialDir, "verifier", "test.stderr"),
					join(trialDir, "verifier", "reward.json"),
					join(trialDir, "verifier", "reward.txt"),
				].filter((file) => existsSync(file)),
				failureReason: failureText || undefined,
				rewardValues: { reward: score },
				evalMetrics: {
					dockerImage: task.dockerImage,
					workItemTags: item.tags,
					agentStatus: agent.parsed?.data?.status,
					agentFailureCategory: agent.parsed?.data?.failureCategory,
					verifierExitCode: verifier.exitCode,
				},
				evaluation: {
					name: "frontierswe",
					dataset: options.split.dataset,
					taskId: item.id,
					runMode: options.split.dataset === FRONTIERSWE_SAMPLE_DATASET ? "sample" : "full",
					adapterVersion: options.repo ? `frontierswe-repo:${options.repo}` : "frontierswe-sample-v1",
					recordedAt: Date.now(),
					model: `${options.modelChoice.provider}/${options.modelChoice.model}:${options.modelChoice.thinkingLevel}`,
					passed: status === "passed",
					score,
				},
			});
		}
	} finally {
		await bundle.cleanup();
	}

	const totalScore = results.reduce((total, result) => total + result.score, 0);
	const maxScore = results.reduce((total, result) => total + result.maxScore, 0);
	const totalCost = results.reduce((total, result) => total + result.totalCost, 0);
	const totalDurationMs = results.reduce((total, result) => total + result.durationMs, 0);
	const passed = results.filter((result) => result.status === "passed").length;
	const failed = results.length - passed;
	return {
		family: options.split.family,
		split: options.split.split,
		dataset: options.split.dataset,
		generatedAt: Date.now(),
		itemCount: results.length,
		passed,
		failed,
		totalScore,
		maxScore,
		meanScore: results.length > 0 ? totalScore / results.length : 0,
		totalCost,
		totalDurationMs,
		tagBreakdown: buildTagBreakdown(results),
		evalMetrics: {
			dataset: options.split.dataset,
			failureCategories: Object.fromEntries(
				results
					.map((result) => result.evalMetrics?.agentFailureCategory)
					.filter((value): value is string => typeof value === "string" && value.length > 0)
					.reduce((counts, category) => counts.set(category, (counts.get(category) ?? 0) + 1), new Map<string, number>()),
			),
		},
		items: results,
	};
}
