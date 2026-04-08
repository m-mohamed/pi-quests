import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyQuestProfilePatch } from "./trials-core.js";
import { getQuestTrialPaths, loadQuestProfile, loadQuestTrialState, saveQuestProfile, saveQuestTrialState } from "./state.js";
import { analyzeCommunityTraces, loadCommunityStats, writeCommunityStats } from "./trace-analyzer.js";
import { executeTrialProposerAgent } from "./workers.js";
import type {
	CommunityStats,
	LiveRunSnapshot,
	ModelChoice,
	QuestBenchmarkTaskDescriptor,
	QuestBenchmarkTaskManifest,
	QuestBenchmarkTaskSplit,
	QuestCandidateScorecard,
	QuestCandidateSummary,
	QuestCandidateTaskResult,
	QuestExperimentCandidate,
	QuestFrontierState,
	QuestProfile,
} from "./types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLE_SEED = 42;
const DEFAULT_SAMPLE_HOLD_OUT_COUNT = 3;

interface FrontierTrialDependencies {
	analyzeCommunity?: typeof analyzeCommunityTraces;
	proposeCandidate?: typeof executeTrialProposerAgent;
	runBenchmarkSet?: typeof runBenchmarkSet;
	now?: () => number;
}

interface PrepareBenchmarkOptions {
	dataset?: string;
	runMode?: "sample" | "full" | "custom";
	seed?: number;
}

interface BaselineOptions {
	force?: boolean;
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface RunOptions extends BaselineOptions {
	iterations?: number;
}

export interface FrontierTrialStatus {
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	profile: QuestProfile;
	searchSet: QuestBenchmarkTaskSplit | null;
	holdOutSet: QuestBenchmarkTaskSplit | null;
	frontier: QuestFrontierState | null;
	communityStats: CommunityStats | null;
	leader: QuestCandidateSummary | null;
}

interface HarborTaskResultRecord {
	taskName: string;
	trialName: string;
	trialDir: string;
	result: Record<string, any>;
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function formatCandidateId(value: number): string {
	return String(value).padStart(3, "0");
}

function candidateDir(cwd: string, candidateId: string): string {
	return join(getQuestTrialPaths(cwd).candidatesDir, candidateId);
}

function candidateProfileFile(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "profile.json");
}

function candidatePatchFile(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "profile.patch.json");
}

function candidateScoreFile(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "scores.json");
}

function candidateHoldOutFile(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "hold-out.json");
}

function candidateSummaryFile(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "summary.json");
}

function candidateTracesRoot(cwd: string, candidateId: string): string {
	return join(candidateDir(cwd, candidateId), "traces");
}

function benchmarkRoot(cwd: string, candidateId: string, split: "search" | "hold-out"): string {
	return join(candidateDir(cwd, candidateId), "benchmarks", split);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

async function writeJsonFile(file: string, payload: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, jsonWithNewline(payload), "utf-8");
}

function mulberry32(seed: number): () => number {
	let current = seed >>> 0;
	return () => {
		current += 0x6d2b79f5;
		let value = Math.imul(current ^ (current >>> 15), 1 | current);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function deterministicShuffle<T>(items: T[], seed: number): T[] {
	const next = [...items];
	const random = mulberry32(seed);
	for (let index = next.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		[next[index], next[swapIndex]] = [next[swapIndex], next[index]];
	}
	return next;
}

function benchmarkRunModeForDataset(dataset: string): "sample" | "full" | "custom" {
	if (dataset.includes("sample")) return "sample";
	if (dataset === "terminal-bench@2.0") return "full";
	return "custom";
}

function normalizeTaskName(dataset: string, task: QuestBenchmarkTaskDescriptor): string {
	if (!dataset.startsWith("terminal-bench")) return task.name;
	const segments = task.name.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? task.name;
}

function normalizeManifest(manifest: QuestBenchmarkTaskManifest): QuestBenchmarkTaskManifest {
	return {
		...manifest,
		tasks: manifest.tasks.map((task) => ({
			...task,
			name: normalizeTaskName(manifest.dataset, task),
		})),
	};
}

function splitNeedsRefresh(split: QuestBenchmarkTaskSplit | null, dataset: string): boolean {
	if (!split) return true;
	if (split.dataset !== dataset) return true;
	return split.tasks.some((task) => task.name.includes("/"));
}

function splitCounts(taskCount: number): { search: number; holdOut: number } {
	if (taskCount <= DEFAULT_SAMPLE_HOLD_OUT_COUNT) return { search: Math.max(1, taskCount - 1), holdOut: Math.min(1, taskCount) };
	if (taskCount === 10) return { search: 7, holdOut: 3 };
	const holdOut = Math.max(1, Math.round(taskCount * 0.3));
	return { search: Math.max(1, taskCount - holdOut), holdOut };
}

function vendoredManifestFile(dataset: string): string {
	return join(PACKAGE_ROOT, "benchmarks", "harbor", "manifests", `${dataset}.json`);
}

async function resolveHarborPython(): Promise<string> {
	const harborExecutable = process.env.HARBOR_BIN ?? process.env.HARBOR_CLI ?? "/Users/mohamedmohamed/.local/bin/harbor";
	const harborPath = existsSync(harborExecutable) ? harborExecutable : "harbor";
	const resolvedHarbor = harborPath === "harbor" ? await realpath("/Users/mohamedmohamed/.local/bin/harbor").catch(() => null) : await realpath(harborPath);
	const pythonPath = resolvedHarbor ? join(dirname(resolvedHarbor), "python") : "";
	if (!pythonPath || !existsSync(pythonPath)) {
		throw new Error("Unable to locate Harbor's Python runtime for dataset metadata loading.");
	}
	return pythonPath;
}

async function loadRegistryManifest(dataset: string, runMode: "sample" | "full" | "custom"): Promise<QuestBenchmarkTaskManifest> {
	const python = await resolveHarborPython();
	const script = `
import json
from harbor.registry.client.factory import RegistryClientFactory

dataset = ${JSON.stringify(dataset)}
client = RegistryClientFactory.create()
metadata = client.get_dataset_metadata(dataset)
payload = {
    "tasks": [
        {
            "name": task.name,
            "path": task.path,
            "gitUrl": getattr(task.task_id, "git_url", None),
            "gitCommitId": getattr(task.task_id, "git_commit_id", None),
        }
        for task in metadata.tasks
    ]
}
print(json.dumps(payload))
`;
	const result = await new Promise<string>((resolvePromise, reject) => {
		const proc = spawn(python, ["-c", script], {
			cwd: PACKAGE_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("close", (code) => {
			if ((code ?? 1) === 0) {
				resolvePromise(stdout);
				return;
			}
			reject(new Error(stderr || `Harbor metadata loader exited with code ${code ?? 1}`));
		});
		proc.on("error", reject);
	});
	const parsed = JSON.parse(result) as { tasks: QuestBenchmarkTaskDescriptor[] };
	return {
		id: dataset,
		benchmark: "terminal-bench",
		dataset,
		runMode,
		createdAt: Date.now(),
		taskCount: parsed.tasks.length,
		source: "registry",
		tasks: parsed.tasks,
		notes: ["Loaded from Harbor registry metadata."],
	};
}

async function loadBenchmarkManifest(dataset: string, runMode: "sample" | "full" | "custom"): Promise<QuestBenchmarkTaskManifest> {
	const vendoredFile = vendoredManifestFile(dataset);
	const vendored = await readJsonFile<QuestBenchmarkTaskManifest>(vendoredFile);
	if (vendored) {
		return normalizeManifest({
			...vendored,
			runMode,
			taskCount: vendored.tasks.length,
		});
	}
	return normalizeManifest(await loadRegistryManifest(dataset, runMode));
}

async function loadTaskSplit(file: string): Promise<QuestBenchmarkTaskSplit | null> {
	return readJsonFile<QuestBenchmarkTaskSplit>(file);
}

async function writeTaskSplit(file: string, split: QuestBenchmarkTaskSplit): Promise<void> {
	await writeJsonFile(file, split);
}

async function nextCandidateId(cwd: string): Promise<string> {
	const paths = getQuestTrialPaths(cwd);
	if (!existsSync(paths.candidatesDir)) return "000";
	const entries = await readdir(paths.candidatesDir, { withFileTypes: true });
	const numericIds = entries
		.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
		.map((entry) => Number(entry.name))
		.filter((value) => Number.isFinite(value))
		.sort((left, right) => left - right);
	if (numericIds.length === 0) return "000";
	return formatCandidateId(numericIds[numericIds.length - 1] + 1);
}

function initialFrontier(): QuestFrontierState {
	return {
		generatedAt: Date.now(),
		frontierCandidateIds: [],
	};
}

async function loadFrontierState(cwd: string): Promise<QuestFrontierState | null> {
	const frontier = await readJsonFile<QuestFrontierState>(getQuestTrialPaths(cwd).frontierFile);
	return frontier;
}

async function saveFrontierState(cwd: string, frontier: QuestFrontierState): Promise<void> {
	await writeJsonFile(getQuestTrialPaths(cwd).frontierFile, frontier);
}

async function loadCandidateSummary(cwd: string, candidateId: string): Promise<QuestCandidateSummary | null> {
	return readJsonFile<QuestCandidateSummary>(candidateSummaryFile(cwd, candidateId));
}

async function saveCandidateArtifacts(
	cwd: string,
	candidateId: string,
	profile: QuestProfile,
	patch: unknown,
	searchScore: QuestCandidateScorecard,
	holdOutScore: QuestCandidateScorecard,
	summary: QuestCandidateSummary,
): Promise<void> {
	await mkdir(candidateDir(cwd, candidateId), { recursive: true });
	await mkdir(candidateTracesRoot(cwd, candidateId), { recursive: true });
	await writeJsonFile(candidateProfileFile(cwd, candidateId), profile);
	await writeJsonFile(candidatePatchFile(cwd, candidateId), patch);
	await writeJsonFile(candidateScoreFile(cwd, candidateId), searchScore);
	await writeJsonFile(candidateHoldOutFile(cwd, candidateId), holdOutScore);
	await writeJsonFile(candidateSummaryFile(cwd, candidateId), summary);
}

async function stageBenchmarkProfile(cwd: string, profile: QuestProfile): Promise<void> {
	await writeJsonFile(join(getQuestTrialPaths(cwd).profilesDir, `${profile.id}.json`), profile);
}

function parseDateOrZero(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function rewardScore(rewards: Record<string, number> | undefined): { score: number; maxScore: number } {
	if (!rewards || Object.keys(rewards).length === 0) return { score: 0, maxScore: 1 };
	if (typeof rewards.reward === "number") {
		return { score: Number(rewards.reward), maxScore: 1 };
	}
	const score = Object.values(rewards).reduce((total, value) => total + Number(value || 0), 0);
	return { score, maxScore: Math.max(1, Object.keys(rewards).length) };
}

async function discoverTrialResults(jobsDir: string): Promise<HarborTaskResultRecord[]> {
	const discovered: HarborTaskResultRecord[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (!entry.isFile() || entry.name !== "result.json") continue;
			const parsed = await readJsonFile<Record<string, any>>(entryPath);
			if (!parsed?.task_name || !parsed?.trial_name) continue;
			const trialUri = typeof parsed.trial_uri === "string" ? parsed.trial_uri : "";
			const trialDir =
				trialUri.startsWith("file://")
					? decodeURIComponent(trialUri.replace(/^file:\/\//, ""))
					: dirname(entryPath);
			discovered.push({
				taskName: String(parsed.task_name),
				trialName: String(parsed.trial_name),
				trialDir,
				result: parsed,
			});
		}
	}

	if (existsSync(jobsDir)) await walk(jobsDir);
	return discovered;
}

function modelChoiceLabel(result: Record<string, any>, fallback: string): string {
	const info = result.agent_info?.model_info;
	if (info?.provider && info?.name) return `${info.provider}/${info.name}`;
	return fallback;
}

async function parseHarborScorecard(
	jobsDir: string,
	tasks: QuestBenchmarkTaskDescriptor[],
	dataset: string,
	split: "search" | "hold-out",
	fallbackModel: string,
): Promise<QuestCandidateScorecard> {
	const trialResults = await discoverTrialResults(jobsDir);
	const byTask = new Map<string, HarborTaskResultRecord>();

	for (const trialResult of trialResults) {
		const previous = byTask.get(trialResult.taskName);
		const previousFinishedAt = previous ? parseDateOrZero(previous.result.finished_at) : -1;
		const nextFinishedAt = parseDateOrZero(trialResult.result.finished_at);
		if (!previous || nextFinishedAt >= previousFinishedAt) byTask.set(trialResult.taskName, trialResult);
	}

	const results: QuestCandidateTaskResult[] = [];
	for (const task of tasks) {
		const trial = byTask.get(task.name);
		if (!trial) {
			results.push({
				taskId: task.path,
				taskName: task.name,
				dataset,
				split,
				status: "error",
				score: 0,
				maxScore: 1,
				durationMs: 0,
				totalCost: 0,
				modelChoice: fallbackModel,
				artifactPaths: [],
				failureReason: "Harbor did not produce a trial result for this task.",
			});
			continue;
		}

		const rewards = trial.result.verifier_result?.rewards as Record<string, number> | undefined;
		const { score, maxScore } = rewardScore(rewards);
		const startedAt = parseDateOrZero(trial.result.started_at);
		const finishedAt = parseDateOrZero(trial.result.finished_at);
		const durationMs = startedAt > 0 && finishedAt >= startedAt ? finishedAt - startedAt : 0;
		const exceptionMessage = trial.result.exception_info?.exception_message as string | undefined;
		const questOutput = await readJsonFile<{ data?: { benchmark?: QuestCandidateTaskResult["benchmark"] } }>(
			join(trial.trialDir, "artifacts", "quest-headless-output.json"),
		);
		results.push({
			taskId: task.path,
			taskName: task.name,
			dataset,
			split,
			status: exceptionMessage ? "error" : score >= maxScore ? "passed" : "failed",
			score,
			maxScore,
			durationMs,
			totalCost: Number(trial.result.agent_result?.cost_usd ?? 0),
			modelChoice: modelChoiceLabel(trial.result, fallbackModel),
			trialDir: trial.trialDir,
			questOutputFile: join(trial.trialDir, "artifacts", "quest-headless-output.json"),
			artifactPaths: [],
			failureReason: exceptionMessage,
			rewardValues: rewards,
			benchmark: questOutput?.data?.benchmark,
		});
	}

	const totalScore = results.reduce((total, item) => total + item.score, 0);
	const maxScore = results.reduce((total, item) => total + item.maxScore, 0);
	const totalCost = results.reduce((total, item) => total + item.totalCost, 0);
	const totalDurationMs = results.reduce((total, item) => total + item.durationMs, 0);
	return {
		split,
		dataset,
		generatedAt: Date.now(),
		taskCount: tasks.length,
		passed: results.filter((item) => item.status === "passed").length,
		failed: results.filter((item) => item.status !== "passed").length,
		totalScore,
		maxScore,
		meanScore: tasks.length > 0 ? totalScore / tasks.length : 0,
		totalCost,
		totalDurationMs,
		tasks: results,
	};
}

function taskTraceDestination(cwd: string, candidateId: string, taskName: string): string {
	const safeSegments = taskName
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "-"));
	return join(candidateTracesRoot(cwd, candidateId), ...safeSegments);
}

async function archiveScorecardArtifacts(cwd: string, candidateId: string, scorecard: QuestCandidateScorecard): Promise<QuestCandidateScorecard> {
	const nextTasks: QuestCandidateTaskResult[] = [];
	for (const task of scorecard.tasks) {
		if (!task.trialDir || !existsSync(task.trialDir)) {
			nextTasks.push(task);
			continue;
		}
		const destination = taskTraceDestination(cwd, candidateId, task.taskName);
		await mkdir(dirname(destination), { recursive: true });
		await cp(task.trialDir, destination, { recursive: true, force: true });
		const copiedQuestOutput = task.questOutputFile ? join(destination, "artifacts", "quest-headless-output.json") : undefined;
		nextTasks.push({
			...task,
			trialDir: destination,
			questOutputFile: copiedQuestOutput && existsSync(copiedQuestOutput) ? copiedQuestOutput : undefined,
			artifactPaths: [destination],
		});
	}
	return {
		...scorecard,
		tasks: nextTasks,
	};
}

async function runHarborSet(
	modelChoice: ModelChoice,
	dataset: string,
	runMode: string,
	profileId: string,
	taskNames: string[],
	jobsDir: string,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<void> {
	const args = [
		"--import",
		"tsx",
		resolve(PACKAGE_ROOT, "benchmarks", "harbor", "run.ts"),
		"--dataset",
		dataset,
		"--run-mode",
		runMode,
		"--jobs-dir",
		jobsDir,
		"--profile",
		profileId,
		"--model",
		`${modelChoice.provider}/${modelChoice.model}`,
	];
	for (const taskName of taskNames) args.push("--include-task-name", taskName);

	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(process.execPath, args, {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
			env: process.env,
		});
		if (typeof proc.pid === "number" && onProcessStart) {
			void Promise.resolve(onProcessStart(proc.pid));
		}
		proc.on("close", (code) => {
			if ((code ?? 1) === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(`Harbor benchmark run failed with exit code ${code ?? 1}.`));
		});
		proc.on("error", reject);
	});
}

async function runBenchmarkSet(
	cwd: string,
	modelChoice: ModelChoice,
	profileId: string,
	split: QuestBenchmarkTaskSplit,
	candidateId: string,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<QuestCandidateScorecard> {
	const jobsDir = benchmarkRoot(cwd, candidateId, split.split);
	await mkdir(jobsDir, { recursive: true });
	await runHarborSet(modelChoice, split.dataset, benchmarkRunModeForDataset(split.dataset), profileId, split.tasks.map((task) => task.name), jobsDir, onProcessStart);
	const scorecard = await parseHarborScorecard(
		jobsDir,
		split.tasks,
		split.dataset,
		split.split,
		`${modelChoice.provider}/${modelChoice.model}`,
	);
	return archiveScorecardArtifacts(cwd, candidateId, scorecard);
}

function dominates(left: QuestCandidateSummary, right: QuestCandidateSummary): boolean {
	if (!left.searchScore || !right.searchScore) return false;
	const betterOrEqual =
		left.searchScore.meanScore >= right.searchScore.meanScore &&
		left.searchScore.totalCost <= right.searchScore.totalCost &&
		left.searchScore.totalDurationMs <= right.searchScore.totalDurationMs;
	const strictlyBetter =
		left.searchScore.meanScore > right.searchScore.meanScore ||
		left.searchScore.totalCost < right.searchScore.totalCost ||
		left.searchScore.totalDurationMs < right.searchScore.totalDurationMs;
	return betterOrEqual && strictlyBetter;
}

function compareLeader(left: QuestCandidateSummary, right: QuestCandidateSummary): number {
	const leftSearch = left.searchScore;
	const rightSearch = right.searchScore;
	if (!leftSearch || !rightSearch) return left.candidateId.localeCompare(right.candidateId);
	if (leftSearch.meanScore !== rightSearch.meanScore) return rightSearch.meanScore - leftSearch.meanScore;
	if (leftSearch.totalCost !== rightSearch.totalCost) return leftSearch.totalCost - rightSearch.totalCost;
	if (leftSearch.totalDurationMs !== rightSearch.totalDurationMs) return leftSearch.totalDurationMs - rightSearch.totalDurationMs;
	return left.candidateId.localeCompare(right.candidateId);
}

async function recomputeFrontier(cwd: string): Promise<{ frontier: QuestFrontierState; leader: QuestCandidateSummary | null }> {
	const paths = getQuestTrialPaths(cwd);
	if (!existsSync(paths.candidatesDir)) return { frontier: initialFrontier(), leader: null };
	const entries = await readdir(paths.candidatesDir, { withFileTypes: true });
	const summaries: QuestCandidateSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const summary = await loadCandidateSummary(cwd, entry.name);
		if (!summary || summary.status === "rejected") continue;
		summaries.push(summary);
	}

	const frontierCandidates = summaries.filter((candidate) => !summaries.some((other) => other.candidateId !== candidate.candidateId && dominates(other, candidate)));
	frontierCandidates.sort(compareLeader);
	const frontierIds = frontierCandidates.map((candidate) => candidate.candidateId);
	const leader = frontierCandidates[0] ?? null;
	for (const summary of summaries) {
		const paretoOptimal = frontierIds.includes(summary.candidateId);
		const status = paretoOptimal ? "frontier" : "archived";
		await writeJsonFile(candidateSummaryFile(cwd, summary.candidateId), {
			...summary,
			paretoOptimal,
			status,
			frontierRank: paretoOptimal ? frontierIds.indexOf(summary.candidateId) + 1 : undefined,
		});
	}

	const frontier: QuestFrontierState = {
		generatedAt: Date.now(),
		leaderCandidateId: leader?.candidateId,
		frontierCandidateIds: frontierIds,
	};
	await saveFrontierState(cwd, frontier);
	return { frontier, leader: leader ? await loadCandidateSummary(cwd, leader.candidateId) : null };
}

async function ensurePreparedBenchmark(cwd: string, options: PrepareBenchmarkOptions = {}): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	searchSet: QuestBenchmarkTaskSplit;
	holdOutSet: QuestBenchmarkTaskSplit;
}> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const dataset = options.dataset ?? state.benchmarkDataset ?? "terminal-bench-sample@2.0";
	const runMode = options.runMode ?? benchmarkRunModeForDataset(dataset);
	const existingSearch = await loadTaskSplit(getQuestTrialPaths(cwd).searchSetFile);
	const existingHoldOut = await loadTaskSplit(getQuestTrialPaths(cwd).holdOutSetFile);
	if (existingSearch && existingHoldOut && !splitNeedsRefresh(existingSearch, dataset) && !splitNeedsRefresh(existingHoldOut, dataset)) {
		state.benchmarkDataset = dataset;
		state.benchmarkRunMode = runMode;
		await saveQuestTrialState(cwd, state);
		return { state, searchSet: existingSearch, holdOutSet: existingHoldOut };
	}
	const prepared = await prepareTrialBenchmark(cwd, { dataset, runMode, seed: options.seed });
	return prepared;
}

async function ensureCommunityStats(
	cwd: string,
	deps: FrontierTrialDependencies,
	force = false,
): Promise<CommunityStats> {
	if (!force) {
		const existing = await loadCommunityStats(cwd);
		if (existing) return existing;
	}
	const paths = getQuestTrialPaths(cwd);
	if (!existsSync(paths.communityTracesDir)) {
		throw new Error(`Community traces directory is missing: ${paths.communityTracesDir}`);
	}
	const analyze = deps.analyzeCommunity ?? analyzeCommunityTraces;
	const stats = await analyze(paths.communityTracesDir);
	if (stats.totalFiles === 0) {
		throw new Error(`Community traces directory is empty: ${paths.communityTracesDir}`);
	}
	await writeCommunityStats(cwd, stats);
	return stats;
}

function passesHoldOutGate(candidate: QuestCandidateSummary, leader: QuestCandidateSummary | null): boolean {
	if (!candidate.holdOutScore) return false;
	if (!leader?.holdOutScore) return true;
	if (candidate.holdOutScore.meanScore < leader.holdOutScore.meanScore) return false;
	if (candidate.holdOutScore.totalScore < leader.holdOutScore.totalScore) return false;
	return true;
}

function baselineSummary(candidateId: string, profile: QuestProfile, searchScore: QuestCandidateScorecard, holdOutScore: QuestCandidateScorecard): QuestCandidateSummary {
	return {
		candidateId,
		profileId: profile.id,
		createdAt: Date.now(),
		source: "baseline",
		status: "frontier",
		summary: `Baseline candidate ${candidateId} for ${searchScore.dataset}`,
		rationale: "Archive the current profile as the first benchmarked frontier candidate.",
		targetedTags: [],
		promptSurfaceIds: [],
		searchScore,
		holdOutScore,
		paretoOptimal: true,
		frontierRank: 1,
	};
}

function candidateSummaryFromProposal(
	candidateId: string,
	profile: QuestProfile,
	proposal: QuestExperimentCandidate,
	searchScore: QuestCandidateScorecard,
	holdOutScore: QuestCandidateScorecard,
	status: QuestCandidateSummary["status"],
	failureReason?: string,
): QuestCandidateSummary {
	return {
		candidateId,
		profileId: profile.id,
		createdAt: Date.now(),
		source: "proposer",
		status,
		summary: proposal.summary,
		rationale: proposal.rationale,
		generalizationNote: proposal.generalizationNote,
		targetedTags: proposal.targetedTags,
		promptSurfaceIds: proposal.promptSurfaceIds,
		searchScore,
		holdOutScore,
		paretoOptimal: status === "frontier",
		failureReason,
	};
}

async function promoteLeaderProfile(cwd: string, leader: QuestCandidateSummary | null): Promise<QuestProfile | null> {
	if (!leader) return null;
	const profile = await readJsonFile<QuestProfile>(candidateProfileFile(cwd, leader.candidateId));
	if (!profile) return null;
	await saveQuestProfile(cwd, profile);
	return profile;
}

export async function prepareTrialBenchmark(cwd: string, options: PrepareBenchmarkOptions = {}): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	searchSet: QuestBenchmarkTaskSplit;
	holdOutSet: QuestBenchmarkTaskSplit;
	manifest: QuestBenchmarkTaskManifest;
}> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const dataset = options.dataset ?? state.benchmarkDataset ?? "terminal-bench-sample@2.0";
	const runMode = options.runMode ?? benchmarkRunModeForDataset(dataset);
	const seed = options.seed ?? DEFAULT_SAMPLE_SEED;
	const manifest = await loadBenchmarkManifest(dataset, runMode);
	const sortedTasks = [...manifest.tasks].sort((left, right) => left.name.localeCompare(right.name));
	const shuffled = deterministicShuffle(sortedTasks, seed);
	const counts = splitCounts(shuffled.length);
	const searchTasks = shuffled.slice(0, counts.search);
	const holdOutTasks = shuffled.slice(counts.search, counts.search + counts.holdOut);
	const createdAt = Date.now();
	const searchSet: QuestBenchmarkTaskSplit = {
		id: `${dataset}-search`,
		benchmark: "terminal-bench",
		dataset,
		split: "search",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		totalTasks: searchTasks.length,
		tasks: searchTasks,
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	const holdOutSet: QuestBenchmarkTaskSplit = {
		id: `${dataset}-hold-out`,
		benchmark: "terminal-bench",
		dataset,
		split: "hold-out",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		totalTasks: holdOutTasks.length,
		tasks: holdOutTasks,
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	await writeTaskSplit(getQuestTrialPaths(cwd).searchSetFile, searchSet);
	await writeTaskSplit(getQuestTrialPaths(cwd).holdOutSetFile, holdOutSet);
	state.benchmarkDataset = dataset;
	state.benchmarkRunMode = runMode;
	state.lastSummary = `Prepared ${dataset}: ${searchSet.totalTasks} search / ${holdOutSet.totalTasks} hold-out tasks.`;
	await saveQuestTrialState(cwd, state);
	return { state, searchSet, holdOutSet, manifest };
}

export async function collectFrontierTrialStatus(cwd: string): Promise<FrontierTrialStatus> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const searchSet = await loadTaskSplit(getQuestTrialPaths(cwd).searchSetFile);
	const holdOutSet = await loadTaskSplit(getQuestTrialPaths(cwd).holdOutSetFile);
	const frontier = await loadFrontierState(cwd);
	const communityStats = await loadCommunityStats(cwd);
	const leader = frontier?.leaderCandidateId ? await loadCandidateSummary(cwd, frontier.leaderCandidateId) : null;
	return { state, profile, searchSet, holdOutSet, frontier, communityStats, leader };
}

export async function runTrialBaseline(
	cwd: string,
	modelChoice: ModelChoice,
	options: BaselineOptions = {},
	deps: FrontierTrialDependencies = {},
): Promise<{ state: Awaited<ReturnType<typeof loadQuestTrialState>>; profile: QuestProfile; summary: string; candidate: QuestCandidateSummary }> {
	const { state, searchSet, holdOutSet } = await ensurePreparedBenchmark(cwd);
	const existing = await loadCandidateSummary(cwd, "000");
	if (existing && !options.force) {
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
		return {
			state,
			profile,
			summary: `Baseline candidate 000 already exists for ${state.benchmarkDataset}.`,
			candidate: existing,
		};
	}

	const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	state.status = "running";
	state.lastSummary = `Running baseline candidate 000 on ${searchSet.dataset}.`;
	await saveQuestTrialState(cwd, state);
	if (options.onSnapshot) {
		await options.onSnapshot({ role: "trial", phase: "baseline-search", updatedAt: Date.now() });
	}
	const runSet = deps.runBenchmarkSet ?? runBenchmarkSet;
	const searchScore = await runSet(cwd, modelChoice, profile.id, searchSet, "000", options.onProcessStart);
	if (options.onSnapshot) {
		await options.onSnapshot({ role: "trial", phase: "baseline-hold-out", updatedAt: Date.now() });
	}
	const holdOutScore = await runSet(cwd, modelChoice, profile.id, holdOutSet, "000", options.onProcessStart);
	const candidate = baselineSummary("000", profile, searchScore, holdOutScore);
	await saveCandidateArtifacts(cwd, "000", profile, {}, searchScore, holdOutScore, candidate);
	const frontier: QuestFrontierState = {
		generatedAt: Date.now(),
		leaderCandidateId: "000",
		frontierCandidateIds: ["000"],
	};
	await saveFrontierState(cwd, frontier);
	state.currentCandidateId = "000";
	state.frontierCandidateIds = frontier.frontierCandidateIds;
	state.status = "idle";
	state.lastSummary = `Baseline archived as candidate 000: ${searchScore.passed}/${searchScore.taskCount} search, ${holdOutScore.passed}/${holdOutScore.taskCount} hold-out.`;
	await saveQuestTrialState(cwd, state);
	await saveQuestProfile(cwd, profile);
	return { state, profile, summary: state.lastSummary, candidate };
}

export async function runTrialOptimization(
	cwd: string,
	modelChoice: ModelChoice,
	options: RunOptions = {},
	deps: FrontierTrialDependencies = {},
): Promise<{ state: Awaited<ReturnType<typeof loadQuestTrialState>>; profile: QuestProfile; summary: string; frontier: QuestFrontierState; leader: QuestCandidateSummary | null }> {
	const iterations = Math.max(1, options.iterations ?? 1);
	await ensurePreparedBenchmark(cwd);
	await ensureCommunityStats(cwd, deps);
	await runTrialBaseline(cwd, modelChoice, {}, deps);

	let state = await loadQuestTrialState(cwd, { ensure: true });
	let leaderFrontier = await loadFrontierState(cwd);
	let leaderSummary = leaderFrontier?.leaderCandidateId ? await loadCandidateSummary(cwd, leaderFrontier.leaderCandidateId) : null;
	let currentProfile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const propose = deps.proposeCandidate ?? executeTrialProposerAgent;
	const runSet = deps.runBenchmarkSet ?? runBenchmarkSet;

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const candidateId = await nextCandidateId(cwd);
		const searchSet = await loadTaskSplit(getQuestTrialPaths(cwd).searchSetFile);
		const holdOutSet = await loadTaskSplit(getQuestTrialPaths(cwd).holdOutSetFile);
		const communityStats = await loadCommunityStats(cwd);
		if (!searchSet || !holdOutSet || !communityStats) {
			throw new Error("Trials are not prepared. Run prepare-benchmark and analyze-community first.");
		}

		state.status = "running";
		state.lastSummary = `Proposer is generating candidate ${candidateId}.`;
		await saveQuestTrialState(cwd, state);
		if (options.onSnapshot) {
			await options.onSnapshot({ role: "proposer", phase: "propose", updatedAt: Date.now() });
		}

		const proposal = await propose(
			cwd,
			modelChoice,
			currentProfile,
			state.target,
			{
				communityStatsPath: getQuestTrialPaths(cwd).communityStatsFile,
				frontierStatePath: getQuestTrialPaths(cwd).frontierFile,
				candidatesDir: getQuestTrialPaths(cwd).candidatesDir,
				searchSetPath: getQuestTrialPaths(cwd).searchSetFile,
				holdOutSetPath: getQuestTrialPaths(cwd).holdOutSetFile,
				communityStats,
				leaderSummary: leaderSummary ?? undefined,
			},
			options.onSnapshot,
			options.onProcessStart,
		);
		if (!proposal.candidate) {
			state.status = "blocked";
			state.lastSummary = "Proposer did not return a valid profile patch.";
			await saveQuestTrialState(cwd, state);
			throw new Error(state.lastSummary);
		}

		const nextProfile = applyQuestProfilePatch(currentProfile, proposal.candidate.patch);
		nextProfile.id = `${state.target}-${state.projectId}-candidate-${candidateId}`;
		nextProfile.updatedAt = Date.now();
		await stageBenchmarkProfile(cwd, nextProfile);
		if (options.onSnapshot) {
			await options.onSnapshot({ role: "trial", phase: "search-benchmark", updatedAt: Date.now() });
		}
		const searchScore = await runSet(cwd, modelChoice, nextProfile.id, searchSet, candidateId, options.onProcessStart);
		if (options.onSnapshot) {
			await options.onSnapshot({ role: "trial", phase: "hold-out-benchmark", updatedAt: Date.now() });
		}
		const holdOutScore = await runSet(cwd, modelChoice, nextProfile.id, holdOutSet, candidateId, options.onProcessStart);
		let candidateSummary = candidateSummaryFromProposal(candidateId, nextProfile, proposal.candidate, searchScore, holdOutScore, "accepted");
		if (!passesHoldOutGate(candidateSummary, leaderSummary)) {
			candidateSummary = {
				...candidateSummary,
				status: "rejected",
				paretoOptimal: false,
				failureReason: "Hold-out score regressed relative to the current leader.",
			};
			await saveCandidateArtifacts(cwd, candidateId, nextProfile, proposal.candidate.patch, searchScore, holdOutScore, candidateSummary);
			continue;
		}

		await saveCandidateArtifacts(cwd, candidateId, nextProfile, proposal.candidate.patch, searchScore, holdOutScore, candidateSummary);
		const recomputed = await recomputeFrontier(cwd);
		leaderFrontier = recomputed.frontier;
		leaderSummary = recomputed.leader;
		const promotedProfile = await promoteLeaderProfile(cwd, leaderSummary);
		if (promotedProfile) currentProfile = promotedProfile;
		state = await loadQuestTrialState(cwd, { ensure: true });
		state.currentCandidateId = candidateId;
		state.frontierCandidateIds = leaderFrontier.frontierCandidateIds;
		state.lastSummary = leaderSummary
			? `Candidate ${candidateId} archived. Leader ${leaderSummary.candidateId}: mean=${leaderSummary.searchScore?.meanScore.toFixed(3) ?? "0.000"} cost=${leaderSummary.searchScore?.totalCost.toFixed(3) ?? "0.000"} duration=${leaderSummary.searchScore?.totalDurationMs ?? 0}ms.`
			: `Candidate ${candidateId} archived.`;
		await saveQuestTrialState(cwd, state);
	}

	state.status = "idle";
	await saveQuestTrialState(cwd, state);
	const frontier = leaderFrontier ?? initialFrontier();
	return {
		state,
		profile: currentProfile,
		summary: state.lastSummary ?? "Frontier trials run completed.",
		frontier,
		leader: leaderSummary,
	};
}

export async function analyzeTrialCommunity(cwd: string, force = false, deps: FrontierTrialDependencies = {}): Promise<CommunityStats> {
	return ensureCommunityStats(cwd, deps, force);
}

export function summarizeTrialStatus(status: FrontierTrialStatus): string {
	const searchSummary = status.searchSet ? `${status.searchSet.totalTasks} search` : "no search split";
	const holdOutSummary = status.holdOutSet ? `${status.holdOutSet.totalTasks} hold-out` : "no hold-out split";
	const communitySummary = status.communityStats ? `${status.communityStats.parsedSessions}/${status.communityStats.totalSessions} community sessions` : "no community stats";
	const leaderSummary = status.leader?.searchScore
		? `leader ${status.leader.candidateId} mean=${status.leader.searchScore.meanScore.toFixed(3)} cost=${status.leader.searchScore.totalCost.toFixed(3)} duration=${status.leader.searchScore.totalDurationMs}ms`
		: "no frontier leader";
	return [
		`Trials status: ${status.state.status}`,
		`Dataset: ${status.state.benchmarkDataset ?? "unset"} (${status.state.benchmarkRunMode ?? "unset"})`,
		`Profile: ${status.profile.id}`,
		`Split: ${searchSummary} / ${holdOutSummary}`,
		`Community: ${communitySummary}`,
		`Frontier: ${status.frontier?.frontierCandidateIds.length ?? 0} candidate(s), ${leaderSummary}`,
	].join("\n");
}
