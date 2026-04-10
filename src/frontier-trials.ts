import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHarborInstallation } from "./harbor-integrity.js";
import { resolveHarborPython } from "./harbor-runtime.js";
import { applyQuestProfilePatch } from "./trials-core.js";
import { getQuestTrialPaths, loadQuestProfile, loadQuestTrialState, saveQuestProfile, saveQuestTrialState } from "./state.js";
import { analyzeCommunityTraces, loadCommunityStats, writeCommunityStats } from "./trace-analyzer.js";
import { compact } from "./utils.js";
import { executeTrialProposerAgent } from "./workers.js";
import type {
	CommunityStats,
	LiveRunSnapshot,
	ModelChoice,
	QuestBenchmarkManifest,
	QuestBenchmarkProvenance,
	QuestBenchmarkRunMode,
	QuestBenchmarkSplit,
	QuestBenchmarkWorkItem,
	QuestCandidateScorecard,
	QuestCandidateSummary,
	QuestCandidateTagMetrics,
	QuestCandidateWorkItemResult,
	QuestExperimentCandidate,
	QuestFrontierBenchmarkFamily,
	QuestFrontierState,
	QuestProfile,
} from "./types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLE_SEED = 42;
const DEFAULT_SAMPLE_HOLD_OUT_COUNT = 3;
const SOURCE_FINGERPRINT_ALGORITHM = "sha1";
const FRONTIER_ADAPTER_VERSION = "frontier-v2";

interface PrepareBenchmarkOptions {
	benchmark?: QuestFrontierBenchmarkFamily;
	dataset?: string;
	repo?: string;
	runMode?: QuestBenchmarkRunMode;
	seed?: number;
	force?: boolean;
}

interface BaselineOptions extends PrepareBenchmarkOptions {
	force?: boolean;
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface RunOptions extends BaselineOptions {
	iterations?: number;
}

type RunBenchmarkSetFn = (
	cwd: string,
	modelChoice: ModelChoice,
	profileId: string,
	split: QuestBenchmarkSplit,
	candidateId: string,
	options?: { repo?: string; onProcessStart?: (pid: number) => void | Promise<void> },
) => Promise<QuestCandidateScorecard>;

interface FrontierTrialDependencies {
	analyzeCommunity?: typeof analyzeCommunityTraces;
	proposeCandidate?: typeof executeTrialProposerAgent;
	runBenchmarkSet?: RunBenchmarkSetFn;
	now?: () => number;
}

interface QuestHeadlessOutputPayload {
	data?: {
		status?: string;
		summary?: string;
		timeoutReason?: string;
		validatorFindings?: string[];
		executionFindings?: string[];
		failureCategory?: string;
		benchmark?: QuestBenchmarkProvenance;
	};
}

export interface FrontierTrialStatus {
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	profile: QuestProfile;
	searchSet: QuestBenchmarkSplit | null;
	holdOutSet: QuestBenchmarkSplit | null;
	frontier: QuestFrontierState | null;
	communityStats: CommunityStats | null;
	leader: QuestCandidateSummary | null;
}

interface BenchmarkAdapter {
	family: QuestFrontierBenchmarkFamily;
	defaultDataset: string;
	resolveRunMode(dataset: string, requested?: QuestBenchmarkRunMode): QuestBenchmarkRunMode;
	discoverManifest(options: {
		dataset: string;
		runMode: QuestBenchmarkRunMode;
		repo?: string;
		now: number;
	}): Promise<QuestBenchmarkManifest>;
	runSplit(options: {
		cwd: string;
		modelChoice: ModelChoice;
		profileId: string;
		split: QuestBenchmarkSplit;
		candidateId: string;
		repo?: string;
		onProcessStart?: (pid: number) => void | Promise<void>;
	}): Promise<QuestCandidateScorecard>;
}

interface HarborTaskResultRecord {
	taskName: string;
	trialDir: string;
	result: Record<string, unknown>;
}

interface SlopCheckpointResult {
	problem: string;
	checkpoint: string;
	path?: string;
	state?: string;
	pass_rate?: number;
	core_pass_rate?: number;
	checkpoint_pass_rate?: number;
	cost?: number;
	elapsed?: number;
	duration?: number;
	started?: string;
	ended?: string;
	steps?: number;
	total_tests?: number;
	passed_tests?: number;
	core_total?: number;
	core_passed?: number;
}

interface SlopRunSummary {
	model?: string;
	num_problems?: number;
	num_checkpoints?: number;
	solve_rates?: Record<string, unknown>;
	costs?: Record<string, unknown>;
	time?: Record<string, unknown>;
	tokens?: Record<string, unknown>;
	pass_rates?: Record<string, unknown>;
	cc?: Record<string, unknown>;
	ratios?: Record<string, unknown>;
	delta?: Record<string, unknown>;
	composite_scores?: Record<string, unknown>;
}

interface RawTerminalBenchTask {
	name?: string;
	path?: string;
	gitUrl?: string;
	gitCommitId?: string;
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function now(deps?: FrontierTrialDependencies): number {
	return deps?.now?.() ?? Date.now();
}

function hashFingerprint(value: string): string {
	return createHash(SOURCE_FINGERPRINT_ALGORITHM).update(value).digest("hex");
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

function defaultDatasetForFamily(family: QuestFrontierBenchmarkFamily): string {
	return family === "slopcodebench" ? "slopcodebench@official" : "terminal-bench-sample@2.0";
}

function sortWorkItems(items: QuestBenchmarkWorkItem[]): QuestBenchmarkWorkItem[] {
	return [...items].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function uniqueTags(tags: Iterable<string | null | undefined>): string[] {
	return [...new Set([...tags].map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean))];
}

function terminalBenchTags(name: string, path?: string): string[] {
	const lower = `${name} ${path ?? ""}`.toLowerCase();
	const tags = new Set<string>(["terminal-bench"]);
	if (/\bqemu\b|\bvm\b|\bboot\b/.test(lower)) tags.add("virtualization");
	if (/\bssh\b/.test(lower)) tags.add("remote-access");
	if (/\btelnet\b|\bserial\b/.test(lower)) tags.add("console-access");
	if (/\bregex\b|\blog\b/.test(lower)) tags.add("text-processing");
	if (/\blog\b/.test(lower)) tags.add("log-analysis");
	if (/\bsqlite\b|\bdb\b|\bgcov\b/.test(lower)) tags.add("database");
	if (/\bgcov\b|\bcoverage\b/.test(lower)) tags.add("coverage");
	if (/\bcython\b|\bbuild\b|\bcompile\b/.test(lower)) tags.add("native-build");
	if (/\bpython\b|\bpy\b|\bcython\b/.test(lower)) tags.add("python");
	if (/\bpolyglot\b/.test(lower)) tags.add("polyglot");
	if (/\bchess\b/.test(lower)) tags.add("reasoning");
	if (/\bvulnerability\b|\bsecurity\b/.test(lower)) tags.add("security");
	if (/\bgit\b/.test(lower)) tags.add("git");
	if (/\bwebserver\b|\bnginx\b|\bhttp\b/.test(lower)) tags.add("webserver");
	return [...tags];
}

function slopCodeBenchTags(metadata?: Record<string, unknown>): string[] {
	const category = typeof metadata?.category === "string" ? metadata.category : "";
	const difficulty = typeof metadata?.difficulty === "string" ? metadata.difficulty : "";
	const checkpointCount = Number(metadata?.checkpointCount ?? 0);
	const tags = new Set<string>(["slopcodebench"]);
	if (category) tags.add(category.toLowerCase());
	if (difficulty) tags.add(`difficulty:${difficulty.toLowerCase()}`);
	if (checkpointCount >= 3) tags.add("long-horizon");
	if (checkpointCount >= 2) tags.add("multi-step");
	return [...tags];
}

function deriveWorkItemTags(
	family: QuestFrontierBenchmarkFamily,
	name: string,
	path?: string,
	metadata?: Record<string, unknown>,
	explicitTags?: Iterable<string | null | undefined>,
): string[] {
	const inferred = family === "slopcodebench" ? slopCodeBenchTags(metadata) : terminalBenchTags(name, path);
	return uniqueTags([...(explicitTags ?? []), ...inferred]);
}

function summarizeTags(items: QuestBenchmarkWorkItem[]): Record<string, number> {
	const summary: Record<string, number> = {};
	for (const item of items) {
		for (const tag of item.tags) summary[tag] = (summary[tag] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])));
}

function primaryTag(item: QuestBenchmarkWorkItem): string {
	return item.tags[0] ?? "untagged";
}

function splitCounts(totalItems: number): { search: number; holdOut: number } {
	if (totalItems <= 1) return { search: totalItems, holdOut: 0 };
	if (totalItems <= DEFAULT_SAMPLE_HOLD_OUT_COUNT) return { search: totalItems - 1, holdOut: 1 };
	if (totalItems === 10) return { search: 7, holdOut: 3 };
	const holdOut = Math.max(1, Math.round(totalItems * 0.3));
	return { search: Math.max(1, totalItems - holdOut), holdOut: totalItems - Math.max(1, totalItems - holdOut) };
}

function hashSeed(seed: number, label: string): number {
	let value = seed >>> 0;
	for (const char of label) {
		value = Math.imul(value ^ char.charCodeAt(0), 1664525) + 1013904223;
	}
	return value >>> 0;
}

function stratifiedSplit(items: QuestBenchmarkWorkItem[], seed: number): { search: QuestBenchmarkWorkItem[]; holdOut: QuestBenchmarkWorkItem[] } {
	const counts = splitCounts(items.length);
	if (counts.holdOut <= 0) return { search: [...items], holdOut: [] };
	const groups = new Map<string, QuestBenchmarkWorkItem[]>();
	for (const item of items) {
		const tag = primaryTag(item);
		const bucket = groups.get(tag) ?? [];
		bucket.push(item);
		groups.set(tag, bucket);
	}
	const groupEntries = [...groups.entries()]
		.map(([tag, groupItems]) => [tag, deterministicShuffle(sortWorkItems(groupItems), hashSeed(seed, tag))] as const)
		.sort((left, right) => left[0].localeCompare(right[0]));
	const quotas = new Map<string, number>();
	const desired = counts.holdOut;
	const total = items.length;
	const remainders: Array<{ tag: string; remainder: number; capacity: number }> = [];
	let assigned = 0;
	for (const [tag, groupItems] of groupEntries) {
		const exact = (groupItems.length / total) * desired;
		const baseQuota = Math.floor(exact);
		const capacity = groupItems.length;
		const quota = Math.min(capacity, baseQuota);
		quotas.set(tag, quota);
		assigned += quota;
		remainders.push({ tag, remainder: exact - baseQuota, capacity });
	}
	remainders.sort((left, right) => right.remainder - left.remainder || left.tag.localeCompare(right.tag));
	for (const entry of remainders) {
		if (assigned >= desired) break;
		const current = quotas.get(entry.tag) ?? 0;
		if (current >= entry.capacity) continue;
		quotas.set(entry.tag, current + 1);
		assigned += 1;
	}

	const holdOut: QuestBenchmarkWorkItem[] = [];
	const search: QuestBenchmarkWorkItem[] = [];
	for (const [tag, groupItems] of groupEntries) {
		const quota = quotas.get(tag) ?? 0;
		holdOut.push(...groupItems.slice(0, quota));
		search.push(...groupItems.slice(quota));
	}
	return {
		search: sortWorkItems(search),
		holdOut: sortWorkItems(holdOut),
	};
}

function buildTagBreakdown(results: QuestCandidateWorkItemResult[]): Record<string, QuestCandidateTagMetrics> {
	const breakdown = new Map<string, { itemCount: number; passed: number; totalScore: number; totalCost: number; totalDurationMs: number }>();
	for (const result of results) {
		const rawTags = Array.isArray(result.benchmarkMetrics?.workItemTags) ? result.benchmarkMetrics?.workItemTags : [];
		const tags = uniqueTags(rawTags as Array<string | null | undefined>);
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
		[...breakdown.entries()]
			.sort((left, right) => left[0].localeCompare(right[0]))
			.map(([tag, metrics]) => [
				tag,
				{
					...metrics,
					meanScore: metrics.itemCount > 0 ? metrics.totalScore / metrics.itemCount : 0,
				},
			]),
	);
}

function normalizeFailureCategory(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function inferFailureCategoryFromText(text: string): string | undefined {
	const normalized = text.toLowerCase();
	if (!normalized) return undefined;
	if (/harbor integrity gate|shared mutable environment|restores \/tests only/.test(normalized)) return "harness_integrity";
	if (/quest-headless output file was empty|invalid quest-headless json|did not produce/.test(normalized)) return "missing_result";
	if (/timed out|timeout|exceeded .*ms/.test(normalized)) return "quest_timeout";
	if (/human handoff|human help|manual/.test(normalized)) return "human_handoff";
	if (/contradict/.test(normalized)) return "contradictory_evidence";
	if (/open question/.test(normalized)) return "open_questions";
	if (/self-check|final submission/.test(normalized)) return "self_check_failed";
	if (/install|dependency|package-manager|build from source|source build|setup path/.test(normalized)) return "setup_overreach";
	if (/blocked|error|exception|failed/.test(normalized)) return "worker_failed";
	return undefined;
}

function classifyFailureCategory(params: {
	status: QuestCandidateWorkItemResult["status"];
	score: number;
	maxScore: number;
	failureReason?: string;
	questOutput?: QuestHeadlessOutputPayload | null;
}): string | undefined {
	const explicit = normalizeFailureCategory(params.questOutput?.data?.failureCategory);
	if (explicit) return explicit;

	const combinedText = compact(
		[
			params.failureReason ?? "",
			params.questOutput?.data?.timeoutReason ?? "",
			params.questOutput?.data?.summary ?? "",
			...(params.questOutput?.data?.executionFindings ?? []),
			...(params.questOutput?.data?.validatorFindings ?? []),
		].join(" "),
	);
	const inferred = inferFailureCategoryFromText(combinedText);
	if (inferred) return inferred;

	if (params.questOutput?.data?.status === "timeout") return "quest_timeout";
	if (params.questOutput?.data?.status === "blocked") return "worker_failed";
	if (params.status === "failed" && params.score < params.maxScore) return "score_shortfall";
	if (params.status === "error") return "worker_failed";
	return undefined;
}

function buildFailureCategoryBreakdown(results: QuestCandidateWorkItemResult[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const result of results) {
		const category = normalizeFailureCategory(result.benchmarkMetrics?.failureCategory);
		if (!category) continue;
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return Object.fromEntries(
		[...counts.entries()]
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
	);
}

function normalizeFrontierFamily(value: unknown): QuestFrontierBenchmarkFamily {
	return value === "slopcodebench" ? "slopcodebench" : "terminal-bench";
}

function normalizeWorkItem(raw: any, fallback: { family: QuestFrontierBenchmarkFamily; dataset: string }): QuestBenchmarkWorkItem {
	const family = normalizeFrontierFamily(raw?.family ?? raw?.benchmark ?? fallback.family);
	const dataset = typeof raw?.dataset === "string" && raw.dataset.trim() ? raw.dataset : fallback.dataset;
	const path = typeof raw?.path === "string" && raw.path.trim() ? raw.path : undefined;
	const id = String(raw?.id ?? path ?? raw?.name ?? "");
	const name = String(raw?.name ?? id);
	const explicitTags = Array.isArray(raw?.tags) ? raw.tags : Array.isArray(raw?.metadata?.tags) ? raw.metadata.tags : [];
	return {
		id,
		name,
		family,
		dataset,
		path,
		tags: deriveWorkItemTags(family, name, path, raw?.metadata, explicitTags),
		metadata: raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : undefined,
	};
}

function normalizeStoredSplit(raw: any): QuestBenchmarkSplit | null {
	if (!raw || typeof raw !== "object") return null;
	const family = normalizeFrontierFamily(raw.family ?? raw.benchmark);
	const dataset = typeof raw.dataset === "string" && raw.dataset.trim() ? raw.dataset : defaultDatasetForFamily(family);
	const rawItems = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.tasks) ? raw.tasks : null;
	if (!rawItems) return null;
	const items = rawItems.map((item: any) => normalizeWorkItem(item, { family, dataset }));
	return {
		id: String(raw.id ?? `${family}-${dataset}-${raw.split ?? "search"}`),
		family,
		dataset,
		split: raw.split === "hold-out" ? "hold-out" : "search",
		createdAt: Number(raw.createdAt ?? Date.now()),
		seed: Number(raw.seed ?? DEFAULT_SAMPLE_SEED),
		sourceManifestId: String(raw.sourceManifestId ?? raw.id ?? `${family}-${dataset}`),
		sourceFingerprint:
			typeof raw.sourceFingerprint === "string" && raw.sourceFingerprint.trim()
				? raw.sourceFingerprint
				: hashFingerprint(JSON.stringify(items.map((item: QuestBenchmarkWorkItem) => ({ id: item.id, name: item.name, path: item.path })))),
		totalItems: Number(raw.totalItems ?? raw.totalTasks ?? items.length),
		items,
		tagSummary: raw.tagSummary && typeof raw.tagSummary === "object" ? Object.fromEntries(Object.entries(raw.tagSummary).map(([key, value]) => [key, Number(value)])) : summarizeTags(items),
		notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
	};
}

async function loadSplit(file: string): Promise<QuestBenchmarkSplit | null> {
	const raw = await readJsonFile<any>(file);
	return normalizeStoredSplit(raw);
}

async function writeSplit(file: string, split: QuestBenchmarkSplit): Promise<void> {
	await writeJsonFile(file, split);
}

function terminalBenchRunMode(dataset: string, requested?: QuestBenchmarkRunMode): QuestBenchmarkRunMode {
	if (requested) return requested;
	if (dataset.includes("sample")) return "sample";
	if (dataset === "terminal-bench@2.0") return "full";
	return "custom";
}

function slopRunMode(_dataset: string, requested?: QuestBenchmarkRunMode): QuestBenchmarkRunMode {
	return requested ?? "custom";
}

function normalizeTerminalBenchTaskName(dataset: string, rawName: string): string {
	if (!dataset.startsWith("terminal-bench")) return rawName;
	const segments = rawName.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? rawName;
}

function normalizeTerminalBenchManifest(raw: any, dataset: string, runMode: QuestBenchmarkRunMode, source: QuestBenchmarkManifest["source"]): QuestBenchmarkManifest {
	const rawItems = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.tasks) ? raw.tasks : [];
	const items = rawItems.map((task: RawTerminalBenchTask) => {
		const path = String(task.path ?? task.name ?? "");
		const name = normalizeTerminalBenchTaskName(dataset, String(task.name ?? path));
		return {
			id: path || name,
			name,
			family: "terminal-bench" as const,
			dataset,
			path: path || undefined,
			tags: deriveWorkItemTags("terminal-bench", name, path || undefined),
			metadata:
				task.gitUrl || task.gitCommitId
					? {
							gitUrl: task.gitUrl,
							gitCommitId: task.gitCommitId,
						}
					: undefined,
		};
	});
	return {
		id: String(raw?.id ?? dataset),
		family: "terminal-bench",
		dataset,
		runMode,
		createdAt: Number(raw?.createdAt ?? Date.now()),
		totalItems: Number(raw?.totalItems ?? raw?.taskCount ?? items.length),
		seed: typeof raw?.seed === "number" ? raw.seed : undefined,
		source: (raw?.source as QuestBenchmarkManifest["source"]) ?? source,
		sourceFingerprint:
			typeof raw?.sourceFingerprint === "string" && raw.sourceFingerprint.trim()
				? raw.sourceFingerprint
				: hashFingerprint(
						JSON.stringify(
							items.map((item: QuestBenchmarkWorkItem) => ({
								id: item.id,
								name: item.name,
								path: item.path,
								tags: item.tags,
								metadata: item.metadata,
							})),
						),
					),
		items: sortWorkItems(items),
		tagSummary: summarizeTags(items),
		notes: Array.isArray(raw?.notes) ? raw.notes.map(String) : undefined,
	};
}

function vendoredTerminalBenchManifestFile(dataset: string): string {
	return join(PACKAGE_ROOT, "benchmarks", "harbor", "manifests", `${dataset}.json`);
}

async function loadTerminalBenchRegistryManifest(dataset: string, runMode: QuestBenchmarkRunMode): Promise<QuestBenchmarkManifest> {
	const python = await resolveHarborPython();
	const script = `
import json
from harbor.registry.client.factory import RegistryClientFactory

dataset = ${JSON.stringify(dataset)}
client = RegistryClientFactory.create()
metadata = client.get_dataset_metadata(dataset)
payload = {
    "id": dataset,
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
	const stdout = await new Promise<string>((resolvePromise, reject) => {
		const proc = spawn(python, ["-c", script], {
			cwd: PACKAGE_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("close", (code) => {
			if ((code ?? 1) === 0) {
				resolvePromise(output);
				return;
			}
			reject(new Error(stderr || `Harbor metadata loader exited with code ${code ?? 1}`));
		});
		proc.on("error", reject);
	});
	return normalizeTerminalBenchManifest(JSON.parse(stdout) as Record<string, unknown>, dataset, runMode, "registry");
}

async function discoverTerminalBenchManifest(options: {
	dataset: string;
	runMode: QuestBenchmarkRunMode;
	now: number;
}): Promise<QuestBenchmarkManifest> {
	const vendored = await readJsonFile<Record<string, unknown>>(vendoredTerminalBenchManifestFile(options.dataset));
	if (vendored) return normalizeTerminalBenchManifest(vendored, options.dataset, options.runMode, "vendored");
	return loadTerminalBenchRegistryManifest(options.dataset, options.runMode);
}

function rewardScore(rewards: Record<string, number> | undefined): { score: number; maxScore: number } {
	if (!rewards || Object.keys(rewards).length === 0) return { score: 0, maxScore: 1 };
	if (typeof rewards.reward === "number") return { score: Number(rewards.reward), maxScore: 1 };
	return {
		score: Object.values(rewards).reduce((total, value) => total + Number(value || 0), 0),
		maxScore: Math.max(1, Object.keys(rewards).length),
	};
}

function parseDateOrZero(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

async function discoverHarborResults(root: string): Promise<HarborTaskResultRecord[]> {
	const discovered: HarborTaskResultRecord[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const next = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(next);
				continue;
			}
			if (!entry.isFile() || entry.name !== "result.json") continue;
			const parsed = await readJsonFile<Record<string, unknown>>(next);
			if (!parsed?.task_name) continue;
			const trialUri = typeof parsed.trial_uri === "string" ? parsed.trial_uri : "";
			const trialDir = trialUri.startsWith("file://") ? decodeURIComponent(trialUri.replace(/^file:\/\//, "")) : dirname(next);
			discovered.push({
				taskName: String(parsed.task_name),
				trialDir,
				result: parsed,
			});
		}
	}
	if (existsSync(root)) await walk(root);
	return discovered;
}

function harborModelChoiceLabel(result: Record<string, unknown>, fallback: string): string {
	const info = (result.agent_info as { model_info?: { provider?: string; name?: string } } | undefined)?.model_info;
	if (info?.provider && info?.name) return `${info.provider}/${info.name}`;
	return fallback;
}

function benchmarkProvenance(
	family: QuestFrontierBenchmarkFamily,
	dataset: string,
	runMode: QuestBenchmarkRunMode,
	itemId: string,
	model: string,
	score: number,
	passed: boolean,
	checkpointId?: string,
): QuestBenchmarkProvenance {
	return {
		benchmark: family,
		dataset,
		taskId: itemId,
		checkpointId,
		runMode,
		adapterVersion: FRONTIER_ADAPTER_VERSION,
		recordedAt: Date.now(),
		model,
		score,
		passed,
	};
}

async function parseHarborScorecard(
	jobsDir: string,
	items: QuestBenchmarkWorkItem[],
	dataset: string,
	split: "search" | "hold-out",
	fallbackModel: string,
	runMode: QuestBenchmarkRunMode,
): Promise<QuestCandidateScorecard> {
	const trialResults = await discoverHarborResults(jobsDir);
	const byTask = new Map<string, HarborTaskResultRecord>();
	for (const trialResult of trialResults) {
		const previous = byTask.get(trialResult.taskName);
		const previousFinishedAt = previous ? parseDateOrZero(previous.result.finished_at as string | undefined) : -1;
		const nextFinishedAt = parseDateOrZero(trialResult.result.finished_at as string | undefined);
		if (!previous || nextFinishedAt >= previousFinishedAt) byTask.set(trialResult.taskName, trialResult);
	}

	const results: QuestCandidateWorkItemResult[] = [];
	for (const item of items) {
		const trial = byTask.get(item.name);
		if (!trial) {
			results.push({
				itemId: item.id,
				itemName: item.name,
				family: "terminal-bench",
				dataset,
				split,
				status: "error",
				score: 0,
				maxScore: 1,
				durationMs: 0,
				totalCost: 0,
				modelChoice: fallbackModel,
				artifactPaths: [],
				failureReason: "Harbor did not produce a result for this task.",
				benchmarkMetrics: { workItemTags: item.tags, failureCategory: "missing_result" },
				benchmark: benchmarkProvenance("terminal-bench", dataset, runMode, item.id, fallbackModel, 0, false),
			});
			continue;
		}
		const rewards = trial.result.verifier_result && typeof trial.result.verifier_result === "object"
			? ((trial.result.verifier_result as { rewards?: Record<string, number> }).rewards ?? undefined)
			: undefined;
		const { score, maxScore } = rewardScore(rewards);
		const startedAt = parseDateOrZero(trial.result.started_at as string | undefined);
		const finishedAt = parseDateOrZero(trial.result.finished_at as string | undefined);
		const durationMs = startedAt > 0 && finishedAt >= startedAt ? finishedAt - startedAt : 0;
		const failureReason =
			typeof (trial.result.exception_info as { exception_message?: string } | undefined)?.exception_message === "string"
				? (trial.result.exception_info as { exception_message?: string }).exception_message
				: undefined;
		const model = harborModelChoiceLabel(trial.result, fallbackModel);
		const questOutputFile = join(trial.trialDir, "artifacts", "quest-headless-output.json");
		const questOutput = await readJsonFile<QuestHeadlessOutputPayload>(questOutputFile);
		const status = failureReason ? "error" : score >= maxScore ? "passed" : "failed";
		const failureCategory = classifyFailureCategory({ status, score, maxScore, failureReason, questOutput });
		results.push({
			itemId: item.id,
			itemName: item.name,
			family: "terminal-bench",
			dataset,
			split,
			status,
			score,
			maxScore,
			durationMs,
			totalCost: Number((trial.result.agent_result as { cost_usd?: number } | undefined)?.cost_usd ?? 0),
			modelChoice: model,
			trialDir: trial.trialDir,
			questOutputFile: existsSync(questOutputFile) ? questOutputFile : undefined,
			artifactPaths: [],
			failureReason,
			rewardValues: rewards,
			benchmarkMetrics: {
				workItemTags: item.tags,
				...(failureCategory ? { failureCategory } : {}),
				...(rewards ? { rewardValues: rewards } : {}),
			},
			benchmark: questOutput?.data?.benchmark ?? benchmarkProvenance("terminal-bench", dataset, runMode, item.id, model, score, status === "passed"),
		});
	}

	const totalScore = results.reduce((total, item) => total + item.score, 0);
	const maxScore = results.reduce((total, item) => total + item.maxScore, 0);
	const totalCost = results.reduce((total, item) => total + item.totalCost, 0);
	const totalDurationMs = results.reduce((total, item) => total + item.durationMs, 0);
	return {
		family: "terminal-bench",
		split,
		dataset,
		generatedAt: Date.now(),
		itemCount: items.length,
		passed: results.filter((item) => item.status === "passed").length,
		failed: results.filter((item) => item.status !== "passed").length,
		totalScore,
		maxScore,
		meanScore: items.length > 0 ? totalScore / items.length : 0,
		totalCost,
		totalDurationMs,
		tagBreakdown: buildTagBreakdown(results),
		benchmarkMetrics: {
			failureCategories: buildFailureCategoryBreakdown(results),
		},
		items: results,
	};
}

async function runTerminalBenchSplit(options: {
	cwd: string;
	modelChoice: ModelChoice;
	profileId: string;
	split: QuestBenchmarkSplit;
	candidateId: string;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<QuestCandidateScorecard> {
	const integrity = await inspectHarborInstallation();
	if (!integrity.ok) {
		throw new Error(`Harbor integrity gate failed. ${integrity.summary}`);
	}
	const jobsDir = benchmarkRoot(options.cwd, options.candidateId, options.split.split);
	await mkdir(jobsDir, { recursive: true });
	const args = [
		"--import",
		"tsx",
		resolve(PACKAGE_ROOT, "benchmarks", "harbor", "run.ts"),
		"--dataset",
		options.split.dataset,
		"--run-mode",
		terminalBenchRunMode(options.split.dataset),
		"--jobs-dir",
		jobsDir,
		"--profile",
		options.profileId,
		"--model",
		`${options.modelChoice.provider}/${options.modelChoice.model}`,
	];
	for (const item of options.split.items) args.push("--include-task-name", item.name);
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(process.execPath, args, {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
			env: process.env,
		});
		if (typeof proc.pid === "number" && options.onProcessStart) {
			void Promise.resolve(options.onProcessStart(proc.pid));
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
	return parseHarborScorecard(
		jobsDir,
		options.split.items,
		options.split.dataset,
		options.split.split,
		`${options.modelChoice.provider}/${options.modelChoice.model}`,
		terminalBenchRunMode(options.split.dataset),
	);
}

async function resolveSlopCodeBenchRepo(explicitRepo?: string): Promise<string> {
	const candidate = explicitRepo?.trim() || process.env.SLOPCODEBENCH_REPO?.trim() || (existsSync("/tmp/slop-code-bench") ? "/tmp/slop-code-bench" : "");
	if (!candidate) {
		throw new Error("SlopCodeBench repo not found. Pass --repo <path>, set SLOPCODEBENCH_REPO, or create /tmp/slop-code-bench.");
	}
	const resolved = resolve(candidate);
	if (!existsSync(resolved)) {
		throw new Error(`SlopCodeBench repo does not exist: ${resolved}`);
	}
	return realpath(resolved).catch(() => resolved);
}

function extractYamlScalar(text: string, key: string): string | undefined {
	const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	if (!match?.[1]) return undefined;
	return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function countCheckpointDefinitions(text: string): number {
	return (text.match(/^ {2}checkpoint_[^:]+:/gm) ?? []).length;
}

async function discoverSlopManifest(options: {
	dataset: string;
	runMode: QuestBenchmarkRunMode;
	repo?: string;
	now: number;
}): Promise<QuestBenchmarkManifest> {
	const repo = await resolveSlopCodeBenchRepo(options.repo);
	const problemsDir = join(repo, "problems");
	if (!existsSync(problemsDir)) {
		throw new Error(`SlopCodeBench problems directory is missing: ${problemsDir}`);
	}
	const entries = await readdir(problemsDir, { withFileTypes: true });
	const items: QuestBenchmarkWorkItem[] = [];
	const fingerprintParts: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const configPath = join(problemsDir, entry.name, "config.yaml");
		if (!existsSync(configPath)) continue;
		const configText = await readFile(configPath, "utf-8");
		const name = extractYamlScalar(configText, "name") ?? entry.name;
		const category = extractYamlScalar(configText, "category");
		const difficulty = extractYamlScalar(configText, "difficulty");
		const description = extractYamlScalar(configText, "description");
		const checkpointCount = countCheckpointDefinitions(configText);
		items.push({
			id: name,
			name,
			family: "slopcodebench",
			dataset: options.dataset,
			path: join(problemsDir, entry.name),
			tags: deriveWorkItemTags("slopcodebench", name, join(problemsDir, entry.name), {
				repo,
				configPath,
				category,
				difficulty,
				description,
				checkpointCount,
			}),
			metadata: {
				repo,
				configPath,
				category,
				difficulty,
				description,
				checkpointCount,
			},
		});
		fingerprintParts.push(`${entry.name}\n${configText}`);
	}
	const sorted = sortWorkItems(items);
	return {
		id: options.dataset,
		family: "slopcodebench",
		dataset: options.dataset,
		runMode: options.runMode,
		createdAt: options.now,
		totalItems: sorted.length,
		source: "discovered",
		sourceFingerprint: hashFingerprint(fingerprintParts.sort().join("\n---\n")),
		items: sorted,
		tagSummary: summarizeTags(sorted),
		notes: [`Discovered from ${repo}.`],
	};
}

async function findLatestResultJson(root: string): Promise<string | null> {
	let latestFile: string | null = null;
	let latestMtimeMs = -1;
	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const next = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(next);
				continue;
			}
			if (!entry.isFile() || entry.name !== "result.json") continue;
			const info = await stat(next);
			if (info.mtimeMs >= latestMtimeMs) {
				latestFile = next;
				latestMtimeMs = info.mtimeMs;
			}
		}
	}
	if (!existsSync(root)) return null;
	await walk(root);
	return latestFile;
}

async function runOfficialSlopCodeBench(options: {
	repo: string;
	problems: string[];
	modelChoice: ModelChoice;
	outputDir: string;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<string> {
	const args = [
		"--import",
		"tsx",
		resolve(PACKAGE_ROOT, "benchmarks", "slopcodebench", "official-run.ts"),
		"--repo",
		options.repo,
		"--model",
		`${options.modelChoice.provider}/${options.modelChoice.model}`,
		"--output-dir",
		options.outputDir,
	];
	for (const problem of options.problems) args.push("--problem", problem);
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(process.execPath, args, {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
			env: process.env,
		});
		if (typeof proc.pid === "number" && options.onProcessStart) {
			void Promise.resolve(options.onProcessStart(proc.pid));
		}
		proc.on("close", (code) => {
			if ((code ?? 1) === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(`SlopCodeBench official run failed with exit code ${code ?? 1}.`));
		});
		proc.on("error", reject);
	});
	const latestResult = await findLatestResultJson(options.outputDir);
	if (!latestResult) {
		throw new Error(`SlopCodeBench did not produce a result.json under ${options.outputDir}`);
	}
	return dirname(latestResult);
}

async function parseSlopCheckpointResults(file: string): Promise<Map<string, SlopCheckpointResult[]>> {
	const grouped = new Map<string, SlopCheckpointResult[]>();
	if (!existsSync(file)) return grouped;
	const lines = (await readFile(file, "utf-8")).split("\n").map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as SlopCheckpointResult;
			if (!parsed.problem) continue;
			const bucket = grouped.get(parsed.problem) ?? [];
			bucket.push(parsed);
			grouped.set(parsed.problem, bucket);
		} catch {
			continue;
		}
	}
	return grouped;
}

function secondsToMs(value: number | undefined): number {
	const numeric = Number(value ?? 0);
	return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * 1000)) : 0;
}

async function findQuestHeadlessOutput(dir: string): Promise<string | undefined> {
	if (!existsSync(dir)) return undefined;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const next = join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = await findQuestHeadlessOutput(next);
			if (nested) return nested;
			continue;
		}
		if (entry.isFile() && entry.name === "quest-headless-output.json") return next;
	}
	return undefined;
}

async function parseSlopScorecard(
	runRoot: string,
	items: QuestBenchmarkWorkItem[],
	dataset: string,
	split: "search" | "hold-out",
	fallbackModel: string,
	runMode: QuestBenchmarkRunMode,
): Promise<QuestCandidateScorecard> {
	const runSummary = (await readJsonFile<SlopRunSummary>(join(runRoot, "result.json"))) ?? {};
	const grouped = await parseSlopCheckpointResults(join(runRoot, "checkpoint_results.jsonl"));
	const results: QuestCandidateWorkItemResult[] = [];
	for (const item of items) {
		const checkpoints = grouped.get(item.id) ?? grouped.get(item.name) ?? [];
		const problemDir = join(runRoot, item.id);
		if (checkpoints.length === 0) {
			results.push({
				itemId: item.id,
				itemName: item.name,
				family: "slopcodebench",
				dataset,
				split,
				status: "error",
				score: 0,
				maxScore: 1,
				durationMs: 0,
				totalCost: 0,
				modelChoice: runSummary.model ?? fallbackModel,
				trialDir: existsSync(problemDir) ? problemDir : undefined,
				artifactPaths: [],
				failureReason: "Official SlopCodeBench run did not produce checkpoint results for this problem.",
				benchmarkMetrics: { workItemTags: item.tags, failureCategory: "missing_result" },
				benchmark: benchmarkProvenance("slopcodebench", dataset, runMode, item.id, runSummary.model ?? fallbackModel, 0, false),
			});
			continue;
		}
		const score = checkpoints.reduce((total, checkpoint) => total + Number(checkpoint.pass_rate ?? checkpoint.checkpoint_pass_rate ?? 0), 0) / checkpoints.length;
		const solvedCheckpoints = checkpoints.filter((checkpoint) => Number(checkpoint.pass_rate ?? checkpoint.checkpoint_pass_rate ?? 0) >= 1).length;
		const totalCost = checkpoints.reduce((total, checkpoint) => total + Number(checkpoint.cost ?? 0), 0);
		const durationMs = checkpoints.reduce((total, checkpoint) => {
			if (typeof checkpoint.elapsed === "number") return total + secondsToMs(checkpoint.elapsed);
			if (typeof checkpoint.duration === "number") return total + secondsToMs(checkpoint.duration);
			const startedAt = parseDateOrZero(checkpoint.started);
			const endedAt = parseDateOrZero(checkpoint.ended);
			return total + (startedAt > 0 && endedAt >= startedAt ? endedAt - startedAt : 0);
		}, 0);
		const status: QuestCandidateWorkItemResult["status"] = solvedCheckpoints === checkpoints.length ? "passed" : "failed";
		const questOutputFile = existsSync(problemDir) ? await findQuestHeadlessOutput(problemDir) : undefined;
		const failureCategory = status === "passed" ? undefined : "score_shortfall";
		results.push({
			itemId: item.id,
			itemName: item.name,
			family: "slopcodebench",
			dataset,
			split,
			status,
			score,
			maxScore: 1,
			durationMs,
			totalCost,
			modelChoice: runSummary.model ?? fallbackModel,
			trialDir: existsSync(problemDir) ? problemDir : undefined,
			questOutputFile,
			artifactPaths: [],
			benchmarkMetrics: {
				workItemTags: item.tags,
				...(failureCategory ? { failureCategory } : {}),
				checkpointCount: checkpoints.length,
				solvedCheckpoints,
				passRateMean: score,
				corePassRateMean:
					checkpoints.reduce((total, checkpoint) => total + Number(checkpoint.core_pass_rate ?? 0), 0) / checkpoints.length,
				totalTests: checkpoints.reduce((total, checkpoint) => total + Number(checkpoint.total_tests ?? 0), 0),
				passedTests: checkpoints.reduce((total, checkpoint) => total + Number(checkpoint.passed_tests ?? 0), 0),
			},
			benchmark: benchmarkProvenance("slopcodebench", dataset, runMode, item.id, runSummary.model ?? fallbackModel, score, status === "passed"),
		});
	}

	const totalScore = results.reduce((total, item) => total + item.score, 0);
	const maxScore = results.reduce((total, item) => total + item.maxScore, 0);
	const totalCost = results.reduce((total, item) => total + item.totalCost, 0);
	const totalDurationMs = results.reduce((total, item) => total + item.durationMs, 0);
	return {
		family: "slopcodebench",
		split,
		dataset,
		generatedAt: Date.now(),
		itemCount: items.length,
		passed: results.filter((item) => item.status === "passed").length,
		failed: results.filter((item) => item.status !== "passed").length,
		totalScore,
		maxScore,
		meanScore: items.length > 0 ? totalScore / items.length : 0,
		totalCost,
		totalDurationMs,
		tagBreakdown: buildTagBreakdown(results),
		benchmarkMetrics: {
			runRoot,
			model: runSummary.model ?? fallbackModel,
			numProblems: runSummary.num_problems,
			numCheckpoints: runSummary.num_checkpoints,
			solveRates: runSummary.solve_rates,
			costs: runSummary.costs,
			time: runSummary.time,
			tokens: runSummary.tokens,
			passRates: runSummary.pass_rates,
			failureCategories: buildFailureCategoryBreakdown(results),
		},
		items: results,
	};
}

async function runSlopCodeBenchSplit(options: {
	cwd: string;
	modelChoice: ModelChoice;
	profileId: string;
	split: QuestBenchmarkSplit;
	candidateId: string;
	repo?: string;
	onProcessStart?: (pid: number) => void | Promise<void>;
}): Promise<QuestCandidateScorecard> {
	const repo = await resolveSlopCodeBenchRepo(options.repo);
	const outputDir = benchmarkRoot(options.cwd, options.candidateId, options.split.split);
	await mkdir(outputDir, { recursive: true });
	const runRoot = await runOfficialSlopCodeBench({
		repo,
		problems: options.split.items.map((item) => item.id),
		modelChoice: options.modelChoice,
		outputDir,
		onProcessStart: options.onProcessStart,
	});
	return parseSlopScorecard(
		runRoot,
		options.split.items,
		options.split.dataset,
		options.split.split,
		`${options.modelChoice.provider}/${options.modelChoice.model}`,
		slopRunMode(options.split.dataset),
	);
}

const BENCHMARK_ADAPTERS: Record<QuestFrontierBenchmarkFamily, BenchmarkAdapter> = {
	"terminal-bench": {
		family: "terminal-bench",
		defaultDataset: "terminal-bench-sample@2.0",
		resolveRunMode: terminalBenchRunMode,
		discoverManifest: discoverTerminalBenchManifest,
		runSplit: runTerminalBenchSplit,
	},
	slopcodebench: {
		family: "slopcodebench",
		defaultDataset: "slopcodebench@official",
		resolveRunMode: slopRunMode,
		discoverManifest: discoverSlopManifest,
		runSplit: runSlopCodeBenchSplit,
	},
};

async function loadFrontierState(cwd: string): Promise<QuestFrontierState | null> {
	return readJsonFile<QuestFrontierState>(getQuestTrialPaths(cwd).frontierFile);
}

async function saveFrontierState(cwd: string, frontier: QuestFrontierState): Promise<void> {
	await writeJsonFile(getQuestTrialPaths(cwd).frontierFile, frontier);
}

async function loadCandidateSummary(cwd: string, candidateId: string): Promise<QuestCandidateSummary | null> {
	return readJsonFile<QuestCandidateSummary>(candidateSummaryFile(cwd, candidateId));
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
	return numericIds.length === 0 ? "000" : formatCandidateId(numericIds[numericIds.length - 1] + 1);
}

async function resetCandidateDir(cwd: string, candidateId: string): Promise<void> {
	await rm(candidateDir(cwd, candidateId), { recursive: true, force: true });
	await mkdir(candidateDir(cwd, candidateId), { recursive: true });
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
	await writeJsonFile(candidateProfileFile(cwd, candidateId), profile);
	await writeJsonFile(candidatePatchFile(cwd, candidateId), patch);
	await writeJsonFile(candidateScoreFile(cwd, candidateId), searchScore);
	await writeJsonFile(candidateHoldOutFile(cwd, candidateId), holdOutScore);
	await writeJsonFile(candidateSummaryFile(cwd, candidateId), summary);
}

async function stageBenchmarkProfile(cwd: string, profile: QuestProfile): Promise<void> {
	await writeJsonFile(join(getQuestTrialPaths(cwd).profilesDir, `${profile.id}.json`), profile);
}

function safeTraceSegments(itemId: string): string[] {
	return itemId
		.split(/[\\/]+/)
		.filter(Boolean)
		.map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "-"));
}

function traceDestination(cwd: string, candidateId: string, itemId: string): string {
	return join(candidateTracesRoot(cwd, candidateId), ...safeTraceSegments(itemId));
}

async function archiveScorecardArtifacts(cwd: string, candidateId: string, scorecard: QuestCandidateScorecard): Promise<QuestCandidateScorecard> {
	const nextItems: QuestCandidateWorkItemResult[] = [];
	for (const item of scorecard.items) {
		if (!item.trialDir || !existsSync(item.trialDir)) {
			nextItems.push(item);
			continue;
		}
		const destination = traceDestination(cwd, candidateId, item.itemId);
		await mkdir(dirname(destination), { recursive: true });
		await rm(destination, { recursive: true, force: true });
		await cp(item.trialDir, destination, { recursive: true, force: true });
		const copiedQuestOutput =
			item.questOutputFile && basename(item.questOutputFile)
				? await findQuestHeadlessOutput(destination)
				: undefined;
		nextItems.push({
			...item,
			trialDir: destination,
			questOutputFile: copiedQuestOutput,
			artifactPaths: [destination],
		});
	}
	return {
		...scorecard,
		items: nextItems,
	};
}

async function runBenchmarkSet(
	cwd: string,
	modelChoice: ModelChoice,
	profileId: string,
	split: QuestBenchmarkSplit,
	candidateId: string,
	options: { repo?: string; onProcessStart?: (pid: number) => void | Promise<void> } = {},
): Promise<QuestCandidateScorecard> {
	const adapter = BENCHMARK_ADAPTERS[split.family];
	const scorecard = await adapter.runSplit({
		cwd,
		modelChoice,
		profileId,
		split,
		candidateId,
		repo: options.repo,
		onProcessStart: options.onProcessStart,
	});
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

function initialFrontier(): QuestFrontierState {
	return {
		generatedAt: Date.now(),
		frontierCandidateIds: [],
	};
}

async function recomputeFrontier(
	cwd: string,
	family: QuestFrontierBenchmarkFamily,
	dataset: string,
): Promise<{ frontier: QuestFrontierState; leader: QuestCandidateSummary | null }> {
	const paths = getQuestTrialPaths(cwd);
	if (!existsSync(paths.candidatesDir)) return { frontier: initialFrontier(), leader: null };
	const entries = await readdir(paths.candidatesDir, { withFileTypes: true });
	const summaries: QuestCandidateSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const summary = await loadCandidateSummary(cwd, entry.name);
		if (!summary) continue;
		if (summary.status === "rejected") continue;
		if (summary.searchScore?.family !== family || summary.searchScore?.dataset !== dataset) continue;
		summaries.push(summary);
	}
	const frontierCandidates = summaries.filter((candidate) => !summaries.some((other) => other.candidateId !== candidate.candidateId && dominates(other, candidate)));
	frontierCandidates.sort(compareLeader);
	const frontierIds = frontierCandidates.map((candidate) => candidate.candidateId);
	for (const summary of summaries) {
		const paretoOptimal = frontierIds.includes(summary.candidateId);
		await writeJsonFile(candidateSummaryFile(cwd, summary.candidateId), {
			...summary,
			paretoOptimal,
			status: paretoOptimal ? "frontier" : "archived",
			frontierRank: paretoOptimal ? frontierIds.indexOf(summary.candidateId) + 1 : undefined,
		});
	}
	const leader = frontierIds.length > 0 ? await loadCandidateSummary(cwd, frontierIds[0]) : null;
	const frontier: QuestFrontierState = {
		generatedAt: Date.now(),
		leaderCandidateId: leader?.candidateId,
		frontierCandidateIds: frontierIds,
	};
	await saveFrontierState(cwd, frontier);
	return { frontier, leader };
}

function baselineSummary(candidateId: string, profile: QuestProfile, searchScore: QuestCandidateScorecard, holdOutScore: QuestCandidateScorecard): QuestCandidateSummary {
	return {
		candidateId,
		profileId: profile.id,
		createdAt: Date.now(),
		source: "baseline",
		status: "accepted",
		summary: `Baseline candidate ${candidateId} for ${searchScore.dataset}`,
		rationale: "Archive the current profile as the baseline frontier candidate for the active benchmark family.",
		targetedTags: [],
		promptSurfaceIds: [],
		searchScore,
		holdOutScore,
		paretoOptimal: false,
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
		paretoOptimal: false,
		failureReason,
	};
}

function passesHoldOutGate(candidate: QuestCandidateSummary, leader: QuestCandidateSummary | null): boolean {
	if (!candidate.holdOutScore) return false;
	if (!leader?.holdOutScore) return true;
	if (candidate.holdOutScore.meanScore < leader.holdOutScore.meanScore) return false;
	if (candidate.holdOutScore.totalScore < leader.holdOutScore.totalScore) return false;
	return true;
}

async function promoteLeaderProfile(cwd: string, leader: QuestCandidateSummary | null): Promise<QuestProfile | null> {
	if (!leader) return null;
	const profile = await readJsonFile<QuestProfile>(candidateProfileFile(cwd, leader.candidateId));
	if (!profile) return null;
	await saveQuestProfile(cwd, profile);
	return profile;
}

function splitMatchesManifest(split: QuestBenchmarkSplit | null, manifest: QuestBenchmarkManifest): boolean {
	if (!split) return false;
	return split.family === manifest.family && split.dataset === manifest.dataset && split.sourceFingerprint === manifest.sourceFingerprint;
}

async function ensurePreparedBenchmark(
	cwd: string,
	options: PrepareBenchmarkOptions = {},
	deps: FrontierTrialDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	searchSet: QuestBenchmarkSplit;
	holdOutSet: QuestBenchmarkSplit;
	manifest: QuestBenchmarkManifest;
}> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const family = options.benchmark ?? state.benchmarkFamily ?? "terminal-bench";
	const adapter = BENCHMARK_ADAPTERS[family];
	const dataset = options.dataset ?? (state.benchmarkFamily === family ? state.benchmarkDataset : undefined) ?? adapter.defaultDataset;
	const runMode = adapter.resolveRunMode(dataset, options.runMode);
	const manifest = await adapter.discoverManifest({ dataset, runMode, repo: options.repo, now: now(deps) });
	const existingSearch = await loadSplit(getQuestTrialPaths(cwd).searchSetFile);
	const existingHoldOut = await loadSplit(getQuestTrialPaths(cwd).holdOutSetFile);
	if (!options.force && splitMatchesManifest(existingSearch, manifest) && splitMatchesManifest(existingHoldOut, manifest)) {
		state.benchmarkFamily = family;
		state.benchmarkDataset = dataset;
		state.benchmarkRunMode = runMode;
		await saveQuestTrialState(cwd, state);
		return {
			state,
			searchSet: existingSearch!,
			holdOutSet: existingHoldOut!,
			manifest,
		};
	}
	return prepareTrialBenchmark(cwd, { ...options, benchmark: family, dataset, runMode }, deps);
}

async function ensureCommunityStats(cwd: string, deps: FrontierTrialDependencies, force = false): Promise<CommunityStats> {
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

export async function prepareTrialBenchmark(
	cwd: string,
	options: PrepareBenchmarkOptions = {},
	deps: FrontierTrialDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	searchSet: QuestBenchmarkSplit;
	holdOutSet: QuestBenchmarkSplit;
	manifest: QuestBenchmarkManifest;
}> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const family = options.benchmark ?? state.benchmarkFamily ?? "terminal-bench";
	const adapter = BENCHMARK_ADAPTERS[family];
	const dataset = options.dataset ?? (state.benchmarkFamily === family ? state.benchmarkDataset : undefined) ?? adapter.defaultDataset;
	const runMode = adapter.resolveRunMode(dataset, options.runMode);
	const seed = options.seed ?? DEFAULT_SAMPLE_SEED;
	const manifest = await adapter.discoverManifest({ dataset, runMode, repo: options.repo, now: now(deps) });
	const splitItems = stratifiedSplit(sortWorkItems(manifest.items), seed);
	const counts = splitCounts(manifest.items.length);
	const createdAt = now(deps);
	const searchSet: QuestBenchmarkSplit = {
		id: `${family}-${dataset}-search`,
		family,
		dataset,
		split: "search",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		sourceFingerprint: manifest.sourceFingerprint,
		totalItems: counts.search,
		items: splitItems.search,
		tagSummary: summarizeTags(splitItems.search),
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	const holdOutSet: QuestBenchmarkSplit = {
		id: `${family}-${dataset}-hold-out`,
		family,
		dataset,
		split: "hold-out",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		sourceFingerprint: manifest.sourceFingerprint,
		totalItems: counts.holdOut,
		items: splitItems.holdOut,
		tagSummary: summarizeTags(splitItems.holdOut),
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	await writeSplit(getQuestTrialPaths(cwd).searchSetFile, searchSet);
	await writeSplit(getQuestTrialPaths(cwd).holdOutSetFile, holdOutSet);
	state.benchmarkFamily = family;
	state.benchmarkDataset = dataset;
	state.benchmarkRunMode = runMode;
	state.lastSummary = `Prepared ${family}:${dataset} with ${searchSet.totalItems} search and ${holdOutSet.totalItems} hold-out items.`;
	await saveQuestTrialState(cwd, state);
	return { state, searchSet, holdOutSet, manifest };
}

export async function collectFrontierTrialStatus(cwd: string): Promise<FrontierTrialStatus> {
	const state = await loadQuestTrialState(cwd, { ensure: true });
	const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const searchSet = await loadSplit(getQuestTrialPaths(cwd).searchSetFile);
	const holdOutSet = await loadSplit(getQuestTrialPaths(cwd).holdOutSetFile);
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
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	profile: QuestProfile;
	summary: string;
	candidate: QuestCandidateSummary;
}> {
	const { state, searchSet, holdOutSet } = await ensurePreparedBenchmark(cwd, options, deps);
	const existing = await loadCandidateSummary(cwd, "000");
	if (
		existing &&
		!options.force &&
		existing.searchScore?.family === searchSet.family &&
		existing.searchScore?.dataset === searchSet.dataset
	) {
		const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
		return {
			state,
			profile,
			summary: `Baseline candidate 000 already exists for ${searchSet.family}:${searchSet.dataset}.`,
			candidate: existing,
		};
	}

	const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	await stageBenchmarkProfile(cwd, profile);
	await resetCandidateDir(cwd, "000");
	state.status = "running";
	state.lastSummary = `Running baseline candidate 000 on ${searchSet.family}:${searchSet.dataset}.`;
	await saveQuestTrialState(cwd, state);
	if (options.onSnapshot) {
		await options.onSnapshot({ role: "trial", phase: "baseline-search", updatedAt: Date.now() });
	}
	const runSet = deps.runBenchmarkSet ?? runBenchmarkSet;
	const searchScore = await runSet(cwd, modelChoice, profile.id, searchSet, "000", {
		repo: options.repo,
		onProcessStart: options.onProcessStart,
	});
	if (options.onSnapshot) {
		await options.onSnapshot({ role: "trial", phase: "baseline-hold-out", updatedAt: Date.now() });
	}
	const holdOutScore = await runSet(cwd, modelChoice, profile.id, holdOutSet, "000", {
		repo: options.repo,
		onProcessStart: options.onProcessStart,
	});
	const candidate = baselineSummary("000", profile, searchScore, holdOutScore);
	await saveCandidateArtifacts(cwd, "000", profile, {}, searchScore, holdOutScore, candidate);
	const { frontier, leader } = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
	state.currentCandidateId = leader?.candidateId ?? "000";
	state.frontierCandidateIds = frontier.frontierCandidateIds;
	state.status = "idle";
	state.lastSummary = `Baseline archived as candidate 000: ${searchScore.passed}/${searchScore.itemCount} search, ${holdOutScore.passed}/${holdOutScore.itemCount} hold-out.`;
	await saveQuestTrialState(cwd, state);
	await saveQuestProfile(cwd, profile);
	return {
		state,
		profile,
		summary: state.lastSummary,
		candidate: (leader && leader.candidateId === "000" ? leader : await loadCandidateSummary(cwd, "000")) ?? candidate,
	};
}

export async function runTrialOptimization(
	cwd: string,
	modelChoice: ModelChoice,
	options: RunOptions = {},
	deps: FrontierTrialDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestTrialState>>;
	profile: QuestProfile;
	summary: string;
	frontier: QuestFrontierState;
	leader: QuestCandidateSummary | null;
}> {
	const iterations = Math.max(1, options.iterations ?? 1);
	const prepared = await ensurePreparedBenchmark(cwd, options, deps);
	await ensureCommunityStats(cwd, deps);
	await runTrialBaseline(cwd, modelChoice, options, deps);

	let state = await loadQuestTrialState(cwd, { ensure: true });
	let frontier = (await loadFrontierState(cwd)) ?? initialFrontier();
	let leader = frontier.leaderCandidateId ? await loadCandidateSummary(cwd, frontier.leaderCandidateId) : null;
	let currentProfile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const propose = deps.proposeCandidate ?? executeTrialProposerAgent;
	const runSet = deps.runBenchmarkSet ?? runBenchmarkSet;

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const candidateId = await nextCandidateId(cwd);
		const searchSet = (await loadSplit(getQuestTrialPaths(cwd).searchSetFile)) ?? prepared.searchSet;
		const holdOutSet = (await loadSplit(getQuestTrialPaths(cwd).holdOutSetFile)) ?? prepared.holdOutSet;
		const communityStats = await loadCommunityStats(cwd);
		if (!communityStats) {
			throw new Error("Community stats are required for frontier optimization. Run /quest trials analyze-community first.");
		}

		state.status = "running";
		state.lastSummary = `Proposer is generating candidate ${candidateId} for ${searchSet.family}:${searchSet.dataset}.`;
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
				searchTagSummary: searchSet.tagSummary,
				holdOutTagSummary: holdOutSet.tagSummary,
				communityStats,
				leaderSummary:
					leader && leader.searchScore
						? {
								candidateId: leader.candidateId,
								summary: leader.summary,
								searchScore: {
									meanScore: leader.searchScore.meanScore,
									totalCost: leader.searchScore.totalCost,
									totalDurationMs: leader.searchScore.totalDurationMs,
								},
								tagBreakdown: leader.searchScore.tagBreakdown,
								failureCategoryBreakdown: (leader.searchScore.benchmarkMetrics?.failureCategories as Record<string, number> | undefined) ?? undefined,
							}
						: undefined,
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
		await resetCandidateDir(cwd, candidateId);
		if (options.onSnapshot) {
			await options.onSnapshot({ role: "trial", phase: "search-benchmark", updatedAt: Date.now() });
		}
		const searchScore = await runSet(cwd, modelChoice, nextProfile.id, searchSet, candidateId, {
			repo: options.repo,
			onProcessStart: options.onProcessStart,
		});
		if (options.onSnapshot) {
			await options.onSnapshot({ role: "trial", phase: "hold-out-benchmark", updatedAt: Date.now() });
		}
		const holdOutScore = await runSet(cwd, modelChoice, nextProfile.id, holdOutSet, candidateId, {
			repo: options.repo,
			onProcessStart: options.onProcessStart,
		});
		let summary = candidateSummaryFromProposal(candidateId, nextProfile, proposal.candidate, searchScore, holdOutScore, "accepted");
		if (!passesHoldOutGate(summary, leader)) {
			summary = {
				...summary,
				status: "rejected",
				failureReason: "Hold-out score regressed relative to the current leader.",
			};
			await saveCandidateArtifacts(cwd, candidateId, nextProfile, proposal.candidate.patch, searchScore, holdOutScore, summary);
			state.lastSummary = `Candidate ${candidateId} rejected: hold-out score regressed.`;
			await saveQuestTrialState(cwd, state);
			continue;
		}

		await saveCandidateArtifacts(cwd, candidateId, nextProfile, proposal.candidate.patch, searchScore, holdOutScore, summary);
		const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
		frontier = recomputed.frontier;
		leader = recomputed.leader;
		const promotedProfile = await promoteLeaderProfile(cwd, leader);
		if (promotedProfile) currentProfile = promotedProfile;
		state = await loadQuestTrialState(cwd, { ensure: true });
		state.currentCandidateId = leader?.candidateId ?? candidateId;
		state.frontierCandidateIds = frontier.frontierCandidateIds;
		state.lastSummary = leader
			? `Candidate ${candidateId} archived. Leader ${leader.candidateId}: mean=${leader.searchScore?.meanScore.toFixed(3) ?? "0.000"} cost=${leader.searchScore?.totalCost.toFixed(3) ?? "0.000"} duration=${leader.searchScore?.totalDurationMs ?? 0}ms.`
			: `Candidate ${candidateId} archived.`;
		await saveQuestTrialState(cwd, state);
	}

	state.status = "idle";
	state.currentCandidateId = leader?.candidateId ?? state.currentCandidateId;
	state.frontierCandidateIds = frontier.frontierCandidateIds;
	await saveQuestTrialState(cwd, state);
	return {
		state,
		profile: currentProfile,
		summary: state.lastSummary ?? "Frontier trials run completed.",
		frontier,
		leader,
	};
}

export async function analyzeTrialCommunity(cwd: string, force = false, deps: FrontierTrialDependencies = {}): Promise<CommunityStats> {
	return ensureCommunityStats(cwd, deps, force);
}

export function summarizeTrialStatus(status: FrontierTrialStatus): string {
	const family = status.state.benchmarkFamily ?? "terminal-bench";
	const dataset = status.state.benchmarkDataset ?? defaultDatasetForFamily(family);
	const runMode = status.state.benchmarkRunMode ?? BENCHMARK_ADAPTERS[family].resolveRunMode(dataset);
	const searchSummary = status.searchSet ? `${status.searchSet.totalItems} search` : "no search split";
	const holdOutSummary = status.holdOutSet ? `${status.holdOutSet.totalItems} hold-out` : "no hold-out split";
	const communitySummary = status.communityStats ? `${status.communityStats.parsedSessions}/${status.communityStats.totalSessions} community sessions` : "no community stats";
	const leaderFailureCategories = Object.entries((status.leader?.searchScore?.benchmarkMetrics?.failureCategories as Record<string, number> | undefined) ?? {})
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 3)
		.map(([category, count]) => `${category}:${count}`)
		.join(", ");
	const leaderSummary = status.leader?.searchScore
		? `leader ${status.leader.candidateId} mean=${status.leader.searchScore.meanScore.toFixed(3)} cost=${status.leader.searchScore.totalCost.toFixed(3)} duration=${status.leader.searchScore.totalDurationMs}ms${leaderFailureCategories ? ` failures=${leaderFailureCategories}` : ""}`
		: "no frontier leader";
	return [
		`Trials status: ${status.state.status}`,
		`Benchmark: ${family}`,
		`Dataset: ${dataset} (${runMode})`,
		`Profile: ${status.profile.id}`,
		`Split: ${searchSummary} / ${holdOutSummary}`,
		`Community: ${communitySummary}`,
		`Frontier: ${status.frontier?.frontierCandidateIds.length ?? 0} candidate(s), ${leaderSummary}`,
	].join("\n");
}
