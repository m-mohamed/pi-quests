import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyQuestProfilePatch } from "./internal-profile-core.js";
import { discoverFrontiersweManifest, runFrontiersweSplit, defaultFrontiersweDataset, resolveFrontiersweRunMode } from "./frontierswe-evals.js";
import { discoverLocalEvalManifest, runLocalEvalSplit, defaultLocalEvalDataset, resolveLocalEvalRunMode } from "./local-evals.js";
import { processExists } from "./runtime-core.js";
import { getQuestOptimizerPaths, loadQuestProfile, loadQuestOptimizerState, saveQuestProfile, saveQuestOptimizerState } from "./state-core.js";
import { analyzeCommunityTraces, loadCommunityStats, writeCommunityStats } from "./trace-analyzer.js";
import { executeOptimizerProposerAgent } from "./workers.js";
import type {
	CommunityStats,
	LiveRunSnapshot,
	ModelChoice,
	QuestCandidateScorecard,
	QuestCandidateSummary,
	QuestEvalManifest,
	QuestEvalRunMode,
	QuestEvalSplit,
	QuestEvalWorkItem,
	QuestExperimentCandidate,
	QuestFailureTag,
	QuestFrontierEvalFamily,
	QuestFrontierState,
	QuestProfile,
	QuestProfilePatch,
	QuestPromptSurfaceId,
	QuestOptimizerPhase,
} from "./types.js";

const DEFAULT_SAMPLE_SEED = 42;
const DEFAULT_SAMPLE_HOLD_OUT_COUNT = 3;
const SOURCE_FINGERPRINT_ALGORITHM = "sha1";

interface PrepareEvalOptions {
	eval?: QuestFrontierEvalFamily;
	suite?: string;
	repo?: string;
	runMode?: QuestEvalRunMode;
	seed?: number;
	force?: boolean;
}

interface BaselineOptions extends PrepareEvalOptions {
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface RunOptions extends BaselineOptions {
	iterations?: number;
}

type RunEvalSetFn = (
	cwd: string,
	modelChoice: ModelChoice,
	profileId: string,
	split: QuestEvalSplit,
	candidateId: string,
	options?: { repo?: string; onProcessStart?: (pid: number) => void | Promise<void> },
) => Promise<QuestCandidateScorecard>;

interface FrontierOptimizerDependencies {
	analyzeCommunity?: typeof analyzeCommunityTraces;
	proposeCandidate?: typeof executeOptimizerProposerAgent;
	runEvalSet?: RunEvalSetFn;
	now?: () => number;
}

export interface FrontierOptimizerStatus {
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>;
	profile: QuestProfile;
	searchSet: QuestEvalSplit | null;
	holdOutSet: QuestEvalSplit | null;
	frontier: QuestFrontierState | null;
	communityStats: CommunityStats | null;
	leader: QuestCandidateSummary | null;
}

interface EvalAdapter {
	family: QuestFrontierEvalFamily;
	defaultDataset: string;
	resolveRunMode(dataset: string, requested?: QuestEvalRunMode): QuestEvalRunMode;
	discoverManifest(options: {
		dataset: string;
		runMode: QuestEvalRunMode;
		repo?: string;
		now: number;
	}): Promise<QuestEvalManifest>;
	runSplit(options: {
		cwd: string;
		modelChoice: ModelChoice;
		profileId: string;
		split: QuestEvalSplit;
		candidateId: string;
		repo?: string;
		onProcessStart?: (pid: number) => void | Promise<void>;
	}): Promise<QuestCandidateScorecard>;
}

export class EvalRunInterruptedError extends Error {
	override name = "EvalRunInterruptedError";
}

export class EvalSplitIntegrityError extends Error {
	override name = "EvalSplitIntegrityError";
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function now(deps?: FrontierOptimizerDependencies): number {
	return deps?.now?.() ?? Date.now();
}

function hashFingerprint(value: string): string {
	return createHash(SOURCE_FINGERPRINT_ALGORITHM).update(value).digest("hex");
}

function formatCandidateId(value: number): string {
	return String(value).padStart(3, "0");
}

function candidateDir(cwd: string, candidateId: string): string {
	return join(getQuestOptimizerPaths(cwd).candidatesDir, candidateId);
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

function evalRoot(cwd: string, candidateId: string, split: "search" | "hold-out"): string {
	return join(candidateDir(cwd, candidateId), "evals", split);
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

function uniqueTags(tags: Iterable<string | null | undefined>): string[] {
	return [...new Set([...tags].map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean))];
}

function sortWorkItems(items: QuestEvalWorkItem[]): QuestEvalWorkItem[] {
	return [...items].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function summarizeTags(items: QuestEvalWorkItem[]): Record<string, number> {
	const summary: Record<string, number> = {};
	for (const item of items) {
		for (const tag of item.tags) summary[tag] = (summary[tag] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])));
}

function primaryTag(item: QuestEvalWorkItem): string {
	return item.tags[0] ?? "untagged";
}

function splitCounts(totalItems: number): { search: number; holdOut: number } {
	if (totalItems <= 1) return { search: totalItems, holdOut: 0 };
	if (totalItems <= DEFAULT_SAMPLE_HOLD_OUT_COUNT) return { search: totalItems - 1, holdOut: 1 };
	if (totalItems === 10) return { search: 7, holdOut: 3 };
	const holdOut = Math.max(1, Math.round(totalItems * 0.3));
	return { search: Math.max(1, totalItems - holdOut), holdOut: totalItems - Math.max(1, totalItems - holdOut) };
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

function hashSeed(seed: number, label: string): number {
	let value = seed >>> 0;
	for (const char of label) value = Math.imul(value ^ char.charCodeAt(0), 1664525) + 1013904223;
	return value >>> 0;
}

function stratifiedSplit(items: QuestEvalWorkItem[], seed: number): { search: QuestEvalWorkItem[]; holdOut: QuestEvalWorkItem[] } {
	const counts = splitCounts(items.length);
	if (counts.holdOut <= 0) return { search: [...items], holdOut: [] };
	const groups = new Map<string, QuestEvalWorkItem[]>();
	for (const item of items) {
		const tag = primaryTag(item);
		const bucket = groups.get(tag) ?? [];
		bucket.push(item);
		groups.set(tag, bucket);
	}
	const groupEntries = [...groups.entries()]
		.map(([tag, groupItems]) => [tag, deterministicShuffle(sortWorkItems(groupItems), hashSeed(seed, tag))] as const)
		.sort((left, right) => left[0].localeCompare(right[0]));
	const desired = counts.holdOut;
	const total = items.length;
	const quotas = new Map<string, number>();
	const remainders: Array<{ tag: string; remainder: number; capacity: number }> = [];
	let assigned = 0;
	for (const [tag, groupItems] of groupEntries) {
		const exact = (groupItems.length / total) * desired;
		const baseQuota = Math.floor(exact);
		const quota = Math.min(groupItems.length, baseQuota);
		quotas.set(tag, quota);
		assigned += quota;
		remainders.push({ tag, remainder: exact - baseQuota, capacity: groupItems.length });
	}
	remainders.sort((left, right) => right.remainder - left.remainder || left.tag.localeCompare(right.tag));
	for (const entry of remainders) {
		if (assigned >= desired) break;
		const current = quotas.get(entry.tag) ?? 0;
		if (current >= entry.capacity) continue;
		quotas.set(entry.tag, current + 1);
		assigned += 1;
	}
	const holdOut: QuestEvalWorkItem[] = [];
	const search: QuestEvalWorkItem[] = [];
	for (const [tag, groupItems] of groupEntries) {
		const quota = quotas.get(tag) ?? 0;
		holdOut.push(...groupItems.slice(0, quota));
		search.push(...groupItems.slice(quota));
	}
	return { search: sortWorkItems(search), holdOut: sortWorkItems(holdOut) };
}

function defaultDatasetForFamily(family: QuestFrontierEvalFamily): string {
	return family === "local" ? defaultLocalEvalDataset() : defaultFrontiersweDataset();
}

function normalizeEvalFamily(value: unknown): QuestFrontierEvalFamily | null {
	if (value === "local" || value === "frontierswe") return value;
	return null;
}

function normalizeWorkItem(raw: any, fallback: { family: QuestFrontierEvalFamily; dataset: string }): QuestEvalWorkItem {
	const family = normalizeEvalFamily(raw?.family ?? fallback.family) ?? fallback.family;
	const dataset = typeof raw?.dataset === "string" && raw.dataset.trim() ? raw.dataset : fallback.dataset;
	return {
		id: String(raw?.id ?? raw?.name ?? ""),
		name: String(raw?.name ?? raw?.id ?? ""),
		family,
		dataset,
		path: typeof raw?.path === "string" ? raw.path : undefined,
		tags: uniqueTags(Array.isArray(raw?.tags) ? raw.tags : []),
		metadata: raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : undefined,
	};
}

function normalizeStoredSplit(raw: any): QuestEvalSplit | null {
	if (!raw || typeof raw !== "object") return null;
	const family = normalizeEvalFamily(raw.family);
	if (!family) return null;
	const dataset = typeof raw.dataset === "string" && raw.dataset.trim() ? raw.dataset : defaultDatasetForFamily(family);
	const rawItems = Array.isArray(raw.items) ? raw.items : null;
	if (!rawItems) return null;
	const items: QuestEvalWorkItem[] = rawItems.map((item: any) => normalizeWorkItem(item, { family, dataset }));
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
				: hashFingerprint(JSON.stringify(items.map((item) => ({ id: item.id, name: item.name, path: item.path })))),
		totalItems: Number(raw.totalItems ?? items.length),
		items,
		tagSummary: raw.tagSummary && typeof raw.tagSummary === "object" ? Object.fromEntries(Object.entries(raw.tagSummary)) : summarizeTags(items),
		notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
	};
}

async function loadSplit(file: string): Promise<QuestEvalSplit | null> {
	const raw = await readJsonFile<any>(file);
	if (raw && typeof raw === "object" && !("family" in raw)) throw unsupportedStoredSplitError();
	return normalizeStoredSplit(raw);
}

async function writeSplit(file: string, split: QuestEvalSplit): Promise<void> {
	await writeJsonFile(file, split);
}

async function loadCandidateSummary(cwd: string, candidateId: string): Promise<QuestCandidateSummary | null> {
	return readJsonFile<QuestCandidateSummary>(candidateSummaryFile(cwd, candidateId));
}

async function saveCandidateSummary(cwd: string, candidateId: string, summary: QuestCandidateSummary): Promise<void> {
	await writeJsonFile(candidateSummaryFile(cwd, candidateId), summary);
}

async function saveCandidateScorecard(cwd: string, candidateId: string, scorecard: QuestCandidateScorecard): Promise<void> {
	const file = scorecard.split === "hold-out" ? candidateHoldOutFile(cwd, candidateId) : candidateScoreFile(cwd, candidateId);
	await writeJsonFile(file, scorecard);
}

async function loadFrontierState(cwd: string): Promise<QuestFrontierState | null> {
	return readJsonFile<QuestFrontierState>(getQuestOptimizerPaths(cwd).frontierFile);
}

async function saveFrontierState(cwd: string, frontier: QuestFrontierState): Promise<void> {
	await writeJsonFile(getQuestOptimizerPaths(cwd).frontierFile, frontier);
}

function initialFrontier(): QuestFrontierState {
	return { generatedAt: Date.now(), frontierCandidateIds: [] };
}

async function prepareCandidateDir(cwd: string, candidateId: string): Promise<void> {
	await mkdir(candidateDir(cwd, candidateId), { recursive: true });
}

async function resetCandidateDir(cwd: string, candidateId: string): Promise<void> {
	await prepareCandidateDir(cwd, candidateId);
	const dir = candidateDir(cwd, candidateId);
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === "evals") continue;
		await rm(join(dir, entry.name), { recursive: true, force: true });
	}
}

async function initializeCandidateArtifacts(
	cwd: string,
	candidateId: string,
	profile: QuestProfile,
	patch: QuestProfilePatch,
): Promise<void> {
	await resetCandidateDir(cwd, candidateId);
	await writeJsonFile(candidateProfileFile(cwd, candidateId), profile);
	await writeJsonFile(candidatePatchFile(cwd, candidateId), patch);
}

function isCompleteCandidateSummary(
	summary: QuestCandidateSummary | null,
	family?: QuestFrontierEvalFamily,
	dataset?: string,
): summary is QuestCandidateSummary {
	if (!summary) return false;
	if (summary.status === "partial" || summary.status === "failed" || summary.status === "rejected") return false;
	if (!summary.searchScore || !summary.holdOutScore) return false;
	if (family && summary.searchScore.family !== family) return false;
	if (dataset && summary.searchScore.dataset !== dataset) return false;
	return true;
}

function leaderCompare(left: QuestCandidateSummary, right: QuestCandidateSummary): number {
	const scoreDelta = (right.searchScore?.meanScore ?? 0) - (left.searchScore?.meanScore ?? 0);
	if (scoreDelta !== 0) return scoreDelta;
	const holdOutDelta = (right.holdOutScore?.meanScore ?? 0) - (left.holdOutScore?.meanScore ?? 0);
	if (holdOutDelta !== 0) return holdOutDelta;
	const costDelta = (left.searchScore?.totalCost ?? 0) - (right.searchScore?.totalCost ?? 0);
	if (costDelta !== 0) return costDelta;
	const durationDelta = (left.searchScore?.totalDurationMs ?? 0) - (right.searchScore?.totalDurationMs ?? 0);
	if (durationDelta !== 0) return durationDelta;
	return left.candidateId.localeCompare(right.candidateId);
}

function candidateDominates(left: QuestCandidateSummary, right: QuestCandidateSummary): boolean {
	if (!left.searchScore || !left.holdOutScore || !right.searchScore || !right.holdOutScore) return false;
	const noWorse =
		left.searchScore.meanScore >= right.searchScore.meanScore &&
		left.holdOutScore.meanScore >= right.holdOutScore.meanScore &&
		left.searchScore.totalCost <= right.searchScore.totalCost &&
		left.searchScore.totalDurationMs <= right.searchScore.totalDurationMs;
	const strictlyBetter =
		left.searchScore.meanScore > right.searchScore.meanScore ||
		left.holdOutScore.meanScore > right.holdOutScore.meanScore ||
		left.searchScore.totalCost < right.searchScore.totalCost ||
		left.searchScore.totalDurationMs < right.searchScore.totalDurationMs;
	return noWorse && strictlyBetter;
}

async function loadAllCandidateSummaries(cwd: string): Promise<QuestCandidateSummary[]> {
	const paths = getQuestOptimizerPaths(cwd);
	if (!existsSync(paths.candidatesDir)) return [];
	const entries = await readdir(paths.candidatesDir, { withFileTypes: true });
	const summaries = await Promise.all(
		entries.filter((entry) => entry.isDirectory()).map((entry) => loadCandidateSummary(cwd, entry.name)),
	);
	return summaries.filter((summary): summary is QuestCandidateSummary => Boolean(summary));
}

async function recomputeFrontier(
	cwd: string,
	family: QuestFrontierEvalFamily,
	dataset: string,
): Promise<{ frontier: QuestFrontierState; leader: QuestCandidateSummary | null }> {
	const all = await loadAllCandidateSummaries(cwd);
	const canonical = all.filter((summary) => isCompleteCandidateSummary(summary, family, dataset));
	const frontierCandidates = canonical.filter(
		(candidate) => !canonical.some((other) => other.candidateId !== candidate.candidateId && candidateDominates(other, candidate)),
	);
	frontierCandidates.sort(leaderCompare);
	const leader = frontierCandidates[0] ?? null;
	const frontier = {
		generatedAt: Date.now(),
		leaderCandidateId: leader?.candidateId,
		frontierCandidateIds: frontierCandidates.map((candidate) => candidate.candidateId),
	} satisfies QuestFrontierState;
	for (const summary of all) {
		if (summary.status === "partial" || summary.status === "failed" || summary.status === "rejected") continue;
		const nextStatus = frontier.frontierCandidateIds.includes(summary.candidateId) ? "frontier" : "archived";
		if (summary.status !== nextStatus || summary.frontierRank !== frontier.frontierCandidateIds.indexOf(summary.candidateId) + 1) {
			summary.status = nextStatus;
			summary.paretoOptimal = nextStatus === "frontier";
			summary.frontierRank = nextStatus === "frontier" ? frontier.frontierCandidateIds.indexOf(summary.candidateId) + 1 : undefined;
			await saveCandidateSummary(cwd, summary.candidateId, summary);
		}
	}
	await saveFrontierState(cwd, frontier);
	return { frontier, leader };
}

function baselineSummary(
	candidateId: string,
	profile: QuestProfile,
	searchScore: QuestCandidateScorecard,
	holdOutScore: QuestCandidateScorecard,
): QuestCandidateSummary {
	return {
		candidateId,
		profileId: profile.id,
		createdAt: Date.now(),
		source: "baseline",
		status: "accepted",
		summary: `Baseline candidate ${candidateId}: ${searchScore.meanScore.toFixed(3)} search / ${holdOutScore.meanScore.toFixed(3)} hold-out.`,
		rationale: "Canonical baseline profile for the current eval suite.",
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
	candidate: QuestExperimentCandidate,
	searchScore: QuestCandidateScorecard,
	holdOutScore: QuestCandidateScorecard,
	status: QuestCandidateSummary["status"],
): QuestCandidateSummary {
	return {
		candidateId,
		profileId: profile.id,
		createdAt: Date.now(),
		source: "proposer",
		status,
		summary: candidate.summary,
		rationale: candidate.rationale,
		generalizationNote: candidate.generalizationNote,
		targetedTags: candidate.targetedTags,
		promptSurfaceIds: candidate.promptSurfaceIds,
		searchScore,
		holdOutScore,
		paretoOptimal: false,
	};
}

function passesHoldOutGate(candidate: QuestCandidateSummary, leader: QuestCandidateSummary | null): boolean {
	if (!leader?.holdOutScore || !candidate.holdOutScore) return true;
	return candidate.holdOutScore.meanScore >= leader.holdOutScore.meanScore;
}

async function promoteLeaderProfile(cwd: string, leader: QuestCandidateSummary | null): Promise<QuestProfile | null> {
	if (!leader) return null;
	const profile = await readJsonFile<QuestProfile>(candidateProfileFile(cwd, leader.candidateId));
	if (!profile) return null;
	await saveQuestProfile(cwd, profile);
	return profile;
}

async function nextCandidateId(cwd: string): Promise<string> {
	const dir = getQuestOptimizerPaths(cwd).candidatesDir;
	await mkdir(dir, { recursive: true });
	const entries = await readdir(dir, { withFileTypes: true });
	const maxValue = entries
		.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
		.reduce((max, entry) => Math.max(max, Number(entry.name)), 0);
	return formatCandidateId(maxValue + 1);
}

function setActiveOptimizerPhase(
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>,
	candidateId: string,
	phase: QuestOptimizerPhase,
	summary: string,
): void {
	state.status = "running";
	state.activeRun = {
		candidateId,
		phase,
		split: phase === "baseline-search" || phase === "search-eval" ? "search" : phase === "baseline-hold-out" || phase === "hold-out-eval" ? "hold-out" : undefined,
		startedAt: Date.now(),
	};
	state.lastSummary = summary;
}

async function persistActiveRunPid(
	cwd: string,
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>,
	pid: number,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<void> {
	if (!state.activeRun) return;
	state.activeRun.pid = pid;
	await saveQuestOptimizerState(cwd, state);
	if (onProcessStart) await onProcessStart(pid);
}

async function materializeIncompleteCandidate(
	cwd: string,
	candidateId: string,
	profile: QuestProfile | undefined,
	patch: QuestProfilePatch | undefined,
	summary: QuestCandidateSummary,
	searchScore?: QuestCandidateScorecard,
	holdOutScore?: QuestCandidateScorecard,
): Promise<QuestCandidateSummary> {
	if (profile) await writeJsonFile(candidateProfileFile(cwd, candidateId), profile);
	if (patch) await writeJsonFile(candidatePatchFile(cwd, candidateId), patch);
	if (searchScore) await writeJsonFile(candidateScoreFile(cwd, candidateId), searchScore);
	if (holdOutScore) await writeJsonFile(candidateHoldOutFile(cwd, candidateId), holdOutScore);
	await saveCandidateSummary(cwd, candidateId, summary);
	return summary;
}

async function ensureCommunityStats(cwd: string, deps: FrontierOptimizerDependencies = {}, force = false): Promise<CommunityStats> {
	if (!force) {
		const existing = await loadCommunityStats(cwd);
		if (existing) return existing;
	}
	const paths = getQuestOptimizerPaths(cwd);
	await mkdir(paths.communityTracesDir, { recursive: true });
	const stats = await (deps.analyzeCommunity ?? analyzeCommunityTraces)(paths.communityTracesDir);
	await writeCommunityStats(cwd, stats);
	return stats;
}

const EVAL_ADAPTERS: Record<QuestFrontierEvalFamily, EvalAdapter> = {
	local: {
		family: "local",
		defaultDataset: defaultLocalEvalDataset(),
		resolveRunMode: resolveLocalEvalRunMode,
		discoverManifest: async ({ dataset, runMode, now: createdAt }) => discoverLocalEvalManifest(dataset, runMode, createdAt),
		runSplit: async ({ cwd, modelChoice, split, candidateId }) => runLocalEvalSplit(cwd, modelChoice, split, candidateId),
	},
	frontierswe: {
		family: "frontierswe",
		defaultDataset: defaultFrontiersweDataset(),
		resolveRunMode: resolveFrontiersweRunMode,
		discoverManifest: async ({ dataset, runMode, repo, now: createdAt }) =>
			discoverFrontiersweManifest({ dataset, runMode, repo, now: createdAt }),
		runSplit: async ({ cwd, modelChoice, profileId, split, candidateId, repo, onProcessStart }) =>
			runFrontiersweSplit({ cwd, modelChoice, profileId, split, candidateId, repo, onProcessStart }),
	},
};

function splitMatchesManifest(split: QuestEvalSplit | null, manifest: QuestEvalManifest): boolean {
	if (!split) return false;
	if (split.family !== manifest.family || split.dataset !== manifest.dataset) return false;
	if (split.sourceFingerprint !== manifest.sourceFingerprint) return false;
	const splitIds = split.items.map((item) => item.id).sort();
	const manifestIds = manifest.items.map((item) => item.id).sort();
	return splitIds.length <= manifestIds.length && splitIds.every((id, index) => id === manifestIds[index]);
}

async function ensurePreparedEval(
	cwd: string,
	options: PrepareEvalOptions = {},
	deps: FrontierOptimizerDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>;
	searchSet: QuestEvalSplit;
	holdOutSet: QuestEvalSplit;
	manifest: QuestEvalManifest;
}> {
	const state = await loadQuestOptimizerState(cwd, { ensure: true });
	const family = options.eval ?? state.evalFamily ?? "frontierswe";
	const adapter = EVAL_ADAPTERS[family];
	const dataset = options.suite ?? (state.evalFamily === family ? state.evalDataset : undefined) ?? adapter.defaultDataset;
	const runMode = adapter.resolveRunMode(dataset, options.runMode);
	const manifest = await adapter.discoverManifest({ dataset, runMode, repo: options.repo, now: now(deps) });
	const searchSet = await loadSplit(getQuestOptimizerPaths(cwd).searchSetFile);
	const holdOutSet = await loadSplit(getQuestOptimizerPaths(cwd).holdOutSetFile);
	if (
		!options.force &&
		splitMatchesManifest(searchSet, manifest) &&
		splitMatchesManifest(holdOutSet, manifest)
	) {
		state.evalFamily = family;
		state.evalDataset = dataset;
		state.evalRunMode = runMode;
		await saveQuestOptimizerState(cwd, state);
		return {
			state,
			searchSet: searchSet!,
			holdOutSet: holdOutSet!,
			manifest,
		};
	}
	return prepareOptimizerEval(cwd, { ...options, eval: family, suite: dataset, runMode }, deps);
}

export async function prepareOptimizerEval(
	cwd: string,
	options: PrepareEvalOptions = {},
	deps: FrontierOptimizerDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>;
	searchSet: QuestEvalSplit;
	holdOutSet: QuestEvalSplit;
	manifest: QuestEvalManifest;
}> {
	const state = await loadQuestOptimizerState(cwd, { ensure: true });
	const family = options.eval ?? state.evalFamily ?? "frontierswe";
	const adapter = EVAL_ADAPTERS[family];
	const dataset = options.suite ?? (state.evalFamily === family ? state.evalDataset : undefined) ?? adapter.defaultDataset;
	const runMode = adapter.resolveRunMode(dataset, options.runMode);
	const seed = options.seed ?? DEFAULT_SAMPLE_SEED;
	const manifest = await adapter.discoverManifest({ dataset, runMode, repo: options.repo, now: now(deps) });
	const splitItems = stratifiedSplit(sortWorkItems(manifest.items), seed);
	const createdAt = now(deps);
	const searchSet: QuestEvalSplit = {
		id: `${family}-${dataset}-search`,
		family,
		dataset,
		split: "search",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		sourceFingerprint: manifest.sourceFingerprint,
		totalItems: splitItems.search.length,
		items: splitItems.search,
		tagSummary: summarizeTags(splitItems.search),
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	const holdOutSet: QuestEvalSplit = {
		id: `${family}-${dataset}-hold-out`,
		family,
		dataset,
		split: "hold-out",
		createdAt,
		seed,
		sourceManifestId: manifest.id,
		sourceFingerprint: manifest.sourceFingerprint,
		totalItems: splitItems.holdOut.length,
		items: splitItems.holdOut,
		tagSummary: summarizeTags(splitItems.holdOut),
		notes: [`Prepared from ${manifest.source} manifest ${manifest.id}.`],
	};
	await writeSplit(getQuestOptimizerPaths(cwd).searchSetFile, searchSet);
	await writeSplit(getQuestOptimizerPaths(cwd).holdOutSetFile, holdOutSet);
	state.evalFamily = family;
	state.evalDataset = dataset;
	state.evalRunMode = runMode;
	state.currentCandidateId = undefined;
	state.frontierCandidateIds = [];
	state.lastSummary = `Prepared ${family}:${dataset} with ${searchSet.totalItems} search and ${holdOutSet.totalItems} hold-out items.`;
	await saveQuestOptimizerState(cwd, state);
	return { state, searchSet, holdOutSet, manifest };
}

async function recoverStaleRunningOptimizerState(
	cwd: string,
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>,
): Promise<{ state: Awaited<ReturnType<typeof loadQuestOptimizerState>>; frontier: QuestFrontierState | null; leader: QuestCandidateSummary | null }> {
	if (state.status !== "running") {
		return { state, frontier: await loadFrontierState(cwd), leader: null };
	}
	const candidateId = state.activeRun?.candidateId ?? state.currentCandidateId;
	const activePid = state.activeRun?.pid;
	const processAlive = typeof activePid === "number" ? processExists(activePid) : false;
	const candidate = candidateId ? await loadCandidateSummary(cwd, candidateId) : null;
	if (!candidateId || processAlive) {
		return { state, frontier: await loadFrontierState(cwd), leader: candidate };
	}
	if (!candidate || !isCompleteCandidateSummary(candidate, state.evalFamily ?? "frontierswe", state.evalDataset ?? defaultDatasetForFamily(state.evalFamily ?? "frontierswe"))) {
		await materializeIncompleteCandidate(
			cwd,
			candidateId,
			await readJsonFile<QuestProfile>(candidateProfileFile(cwd, candidateId)) ?? undefined,
			(await readJsonFile<QuestProfilePatch>(candidatePatchFile(cwd, candidateId))) ?? undefined,
			{
				...(candidate ?? {
					candidateId,
					profileId: state.activeProfileId,
					createdAt: Date.now(),
					source: candidateId === "000" ? "baseline" : "proposer",
					status: "partial",
					summary: `Candidate ${candidateId} recovered from stale running state.`,
					rationale: "Preserve incomplete eval artifacts during stale-state recovery.",
					targetedTags: [],
					promptSurfaceIds: [],
					paretoOptimal: false,
				}),
				status: "partial",
				summary: `Candidate ${candidateId} recovered from stale running state.`,
				rationale: "Preserve incomplete eval artifacts during stale-state recovery.",
				failureReason: typeof activePid === "number" ? `Recovered after process ${activePid} exited.` : "Recovered without a live process marker.",
			},
			await readJsonFile<QuestCandidateScorecard>(candidateScoreFile(cwd, candidateId)) ?? undefined,
			await readJsonFile<QuestCandidateScorecard>(candidateHoldOutFile(cwd, candidateId)) ?? undefined,
		);
	}
	const recomputed = await recomputeFrontier(
		cwd,
		state.evalFamily ?? "frontierswe",
		state.evalDataset ?? defaultDatasetForFamily(state.evalFamily ?? "frontierswe"),
	);
	state.activeRun = undefined;
	state.status = "stopped";
	state.currentCandidateId = recomputed.leader?.candidateId;
	state.frontierCandidateIds = recomputed.frontier.frontierCandidateIds;
	state.lastSummary = candidateId ? `Recovered stale running state for candidate ${candidateId}.` : "Recovered stale running state.";
	await saveQuestOptimizerState(cwd, state);
	return { state, frontier: recomputed.frontier, leader: recomputed.leader };
}

export async function collectFrontierOptimizerStatus(cwd: string): Promise<FrontierOptimizerStatus> {
	const loadedState = await loadQuestOptimizerState(cwd, { ensure: true });
	const recovered = await recoverStaleRunningOptimizerState(cwd, loadedState);
	const state = recovered.state;
	const profile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const searchSet = await loadSplit(getQuestOptimizerPaths(cwd).searchSetFile);
	const holdOutSet = await loadSplit(getQuestOptimizerPaths(cwd).holdOutSetFile);
	const frontier = recovered.frontier ?? (await loadFrontierState(cwd));
	const communityStats = await loadCommunityStats(cwd);
	const leader = recovered.leader ?? (frontier?.leaderCandidateId ? await loadCandidateSummary(cwd, frontier.leaderCandidateId) : null);
	if (state.status !== "running") {
		const expectedLeaderId = frontier?.leaderCandidateId;
		const expectedFrontierIds = frontier?.frontierCandidateIds ?? [];
		const currentFrontierIds = state.frontierCandidateIds ?? [];
		const frontierChanged =
			currentFrontierIds.length !== expectedFrontierIds.length ||
			currentFrontierIds.some((candidateId, index) => candidateId !== expectedFrontierIds[index]);
		if (state.currentCandidateId !== expectedLeaderId || frontierChanged) {
			state.currentCandidateId = expectedLeaderId;
			state.frontierCandidateIds = expectedFrontierIds;
			await saveQuestOptimizerState(cwd, state);
		}
	}
	return { state, profile, searchSet, holdOutSet, frontier, communityStats, leader };
}

export async function runOptimizerBaseline(
	cwd: string,
	modelChoice: ModelChoice,
	options: BaselineOptions = {},
	deps: FrontierOptimizerDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>;
	profile: QuestProfile;
	summary: string;
	candidate: QuestCandidateSummary;
}> {
	const { state, searchSet, holdOutSet } = await ensurePreparedEval(cwd, options, deps);
	const existing = await loadCandidateSummary(cwd, "000");
	if (
		isCompleteCandidateSummary(existing, searchSet.family, searchSet.dataset) &&
		!options.force &&
		existing.holdOutScore?.family === holdOutSet.family
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
	await saveQuestProfile(cwd, profile);
	await initializeCandidateArtifacts(cwd, "000", profile, {});
	const runSet = deps.runEvalSet ?? ((cwdArg, modelArg, profileId, split, candidateId, runOptions) =>
		EVAL_ADAPTERS[split.family].runSplit({
			cwd: cwdArg,
			modelChoice: modelArg,
			profileId,
			split,
			candidateId,
			repo: runOptions?.repo,
			onProcessStart: runOptions?.onProcessStart,
		}));
	let searchScore: QuestCandidateScorecard | undefined;
	let holdOutScore: QuestCandidateScorecard | undefined;
	try {
		setActiveOptimizerPhase(state, "000", "baseline-search", `Running baseline candidate 000 on ${searchSet.family}:${searchSet.dataset}.`);
		await saveQuestOptimizerState(cwd, state);
		if (options.onSnapshot) await options.onSnapshot({ role: "optimizer", phase: "baseline-search", updatedAt: Date.now() });
		searchScore = await runSet(cwd, modelChoice, profile.id, searchSet, "000", {
			repo: options.repo,
			onProcessStart: async (pid) => persistActiveRunPid(cwd, state, pid, options.onProcessStart),
		});
		await saveCandidateScorecard(cwd, "000", searchScore);
		setActiveOptimizerPhase(state, "000", "baseline-hold-out", `Running hold-out for baseline candidate 000 on ${holdOutSet.family}:${holdOutSet.dataset}.`);
		await saveQuestOptimizerState(cwd, state);
		if (options.onSnapshot) await options.onSnapshot({ role: "optimizer", phase: "baseline-hold-out", updatedAt: Date.now() });
		holdOutScore = await runSet(cwd, modelChoice, profile.id, holdOutSet, "000", {
			repo: options.repo,
			onProcessStart: async (pid) => persistActiveRunPid(cwd, state, pid, options.onProcessStart),
		});
		await saveCandidateScorecard(cwd, "000", holdOutScore);
		const candidate = baselineSummary("000", profile, searchScore, holdOutScore);
		await saveCandidateSummary(cwd, "000", candidate);
		const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
		state.currentCandidateId = recomputed.leader?.candidateId ?? "000";
		state.frontierCandidateIds = recomputed.frontier.frontierCandidateIds;
		state.status = "idle";
		state.lastSummary = `Baseline archived as candidate 000: ${searchScore.passed}/${searchScore.itemCount} search, ${holdOutScore.passed}/${holdOutScore.itemCount} hold-out.`;
		await saveQuestOptimizerState(cwd, state);
		return { state, profile, summary: state.lastSummary, candidate };
	} catch (error) {
		if (error instanceof EvalRunInterruptedError) {
			const partial = await materializeIncompleteCandidate(
				cwd,
				"000",
				profile,
				{},
				{
					candidateId: "000",
					profileId: profile.id,
					createdAt: Date.now(),
					source: "baseline",
					status: "partial",
					summary: `Baseline candidate 000 stopped during ${state.activeRun?.phase ?? "baseline execution"}.`,
					rationale: "Preserve interrupted eval artifacts for inspection before rerunning the baseline.",
					targetedTags: [],
					promptSurfaceIds: [],
					searchScore,
					holdOutScore,
					paretoOptimal: false,
					failureReason: error.message,
				},
				searchScore,
				holdOutScore,
			);
			const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
			state.currentCandidateId = recomputed.leader?.candidateId;
			state.frontierCandidateIds = recomputed.frontier.frontierCandidateIds;
			state.status = "stopped";
			state.lastSummary = partial.summary;
			await saveQuestOptimizerState(cwd, state);
			return { state, profile, summary: state.lastSummary, candidate: partial };
		}
		const failed = await materializeIncompleteCandidate(
			cwd,
			"000",
			profile,
			{},
			{
				candidateId: "000",
				profileId: profile.id,
				createdAt: Date.now(),
				source: "baseline",
				status: "failed",
				summary: `Baseline candidate 000 failed during ${state.activeRun?.phase ?? "baseline execution"}.`,
				rationale: "Preserve failed baseline artifacts while keeping incomplete candidates out of the frontier.",
				targetedTags: [],
				promptSurfaceIds: [],
				searchScore,
				holdOutScore,
				paretoOptimal: false,
				failureReason: error instanceof Error ? error.message : String(error),
			},
			searchScore,
			holdOutScore,
		);
		const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
		state.currentCandidateId = recomputed.leader?.candidateId;
		state.frontierCandidateIds = recomputed.frontier.frontierCandidateIds;
		state.status = "blocked";
		state.lastSummary = failed.summary;
		await saveQuestOptimizerState(cwd, state);
		throw error;
	} finally {
		state.activeRun = undefined;
		if (state.status === "running") state.status = "idle";
		await saveQuestOptimizerState(cwd, state);
	}
}

export async function runOptimizerOptimization(
	cwd: string,
	modelChoice: ModelChoice,
	options: RunOptions = {},
	deps: FrontierOptimizerDependencies = {},
): Promise<{
	state: Awaited<ReturnType<typeof loadQuestOptimizerState>>;
	profile: QuestProfile;
	summary: string;
	frontier: QuestFrontierState;
	leader: QuestCandidateSummary | null;
}> {
	const iterations = Math.max(1, options.iterations ?? 1);
	const prepared = await ensurePreparedEval(cwd, options, deps);
	await ensureCommunityStats(cwd, deps);
	const baseline = await runOptimizerBaseline(cwd, modelChoice, options, deps);
	if (baseline.state.status !== "idle") {
		const frontier = (await loadFrontierState(cwd)) ?? initialFrontier();
		const leader = frontier.leaderCandidateId ? await loadCandidateSummary(cwd, frontier.leaderCandidateId) : null;
		return { state: baseline.state, profile: baseline.profile, summary: baseline.summary, frontier, leader };
	}

	let state = await loadQuestOptimizerState(cwd, { ensure: true });
	let frontier = (await loadFrontierState(cwd)) ?? initialFrontier();
	let leader = frontier.leaderCandidateId ? await loadCandidateSummary(cwd, frontier.leaderCandidateId) : null;
	let currentProfile = await loadQuestProfile(cwd, state.activeProfileId, { ensure: true, target: state.target });
	const propose = deps.proposeCandidate ?? executeOptimizerProposerAgent;
	const runSet = deps.runEvalSet ?? ((cwdArg, modelArg, profileId, split, candidateId, runOptions) =>
		EVAL_ADAPTERS[split.family].runSplit({
			cwd: cwdArg,
			modelChoice: modelArg,
			profileId,
			split,
			candidateId,
			repo: runOptions?.repo,
			onProcessStart: runOptions?.onProcessStart,
		}));

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const candidateId = await nextCandidateId(cwd);
		const searchSet = (await loadSplit(getQuestOptimizerPaths(cwd).searchSetFile)) ?? prepared.searchSet;
		const holdOutSet = (await loadSplit(getQuestOptimizerPaths(cwd).holdOutSetFile)) ?? prepared.holdOutSet;
		const communityStats = await loadCommunityStats(cwd);
		if (!communityStats) throw new Error("Community stats are required for frontier optimization. Run /quest evals analyze-community first.");

		let proposal: Awaited<ReturnType<typeof executeOptimizerProposerAgent>> | undefined;
		let nextProfile: QuestProfile | undefined;
		let searchScore: QuestCandidateScorecard | undefined;
		let holdOutScore: QuestCandidateScorecard | undefined;
		try {
			setActiveOptimizerPhase(state, candidateId, "propose", `Proposer is generating candidate ${candidateId} for ${searchSet.family}:${searchSet.dataset}.`);
			await saveQuestOptimizerState(cwd, state);
			if (options.onSnapshot) await options.onSnapshot({ role: "proposer", phase: "propose", updatedAt: Date.now() });
			proposal = await propose(
				cwd,
				modelChoice,
				currentProfile,
				state.target,
				{
					communityStatsPath: getQuestOptimizerPaths(cwd).communityStatsFile,
					frontierStatePath: getQuestOptimizerPaths(cwd).frontierFile,
					candidatesDir: getQuestOptimizerPaths(cwd).candidatesDir,
					searchSetPath: getQuestOptimizerPaths(cwd).searchSetFile,
					holdOutSetPath: getQuestOptimizerPaths(cwd).holdOutSetFile,
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
									failureCategoryBreakdown: (leader.searchScore.evalMetrics?.failureCategories as Record<string, number> | undefined) ?? undefined,
								}
							: undefined,
				},
				options.onSnapshot,
				async (pid) => persistActiveRunPid(cwd, state, pid, options.onProcessStart),
			);
			if (!proposal.candidate) {
				state.status = "blocked";
				state.lastSummary = "Proposer did not return a valid profile patch.";
				throw new Error(state.lastSummary);
			}
			nextProfile = applyQuestProfilePatch(currentProfile, proposal.candidate.patch);
			nextProfile.id = `${state.target}-${state.projectId}-candidate-${candidateId}`;
			nextProfile.updatedAt = Date.now();
			await initializeCandidateArtifacts(cwd, candidateId, nextProfile, proposal.candidate.patch);
			setActiveOptimizerPhase(state, candidateId, "search-eval", `Running search split for candidate ${candidateId} on ${searchSet.family}:${searchSet.dataset}.`);
			await saveQuestOptimizerState(cwd, state);
			if (options.onSnapshot) await options.onSnapshot({ role: "optimizer", phase: "search-eval", updatedAt: Date.now() });
			searchScore = await runSet(cwd, modelChoice, nextProfile.id, searchSet, candidateId, {
				repo: options.repo,
				onProcessStart: async (pid) => persistActiveRunPid(cwd, state, pid, options.onProcessStart),
			});
			await saveCandidateScorecard(cwd, candidateId, searchScore);
			setActiveOptimizerPhase(state, candidateId, "hold-out-eval", `Running hold-out split for candidate ${candidateId} on ${holdOutSet.family}:${holdOutSet.dataset}.`);
			await saveQuestOptimizerState(cwd, state);
			if (options.onSnapshot) await options.onSnapshot({ role: "optimizer", phase: "hold-out-eval", updatedAt: Date.now() });
			holdOutScore = await runSet(cwd, modelChoice, nextProfile.id, holdOutSet, candidateId, {
				repo: options.repo,
				onProcessStart: async (pid) => persistActiveRunPid(cwd, state, pid, options.onProcessStart),
			});
			await saveCandidateScorecard(cwd, candidateId, holdOutScore);
			let summary = candidateSummaryFromProposal(candidateId, nextProfile, proposal.candidate, searchScore, holdOutScore, "accepted");
			if (!passesHoldOutGate(summary, leader)) {
				summary = { ...summary, status: "rejected", failureReason: "Hold-out score regressed relative to the current leader." };
				await saveCandidateSummary(cwd, candidateId, summary);
				state.lastSummary = `Candidate ${candidateId} rejected: hold-out score regressed.`;
				await saveQuestOptimizerState(cwd, state);
				continue;
			}
			await saveCandidateSummary(cwd, candidateId, summary);
			const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
			frontier = recomputed.frontier;
			leader = recomputed.leader;
			const promotedProfile = await promoteLeaderProfile(cwd, leader);
			if (promotedProfile) currentProfile = promotedProfile;
			state.currentCandidateId = leader?.candidateId ?? candidateId;
			state.frontierCandidateIds = frontier.frontierCandidateIds;
			state.lastSummary = leader
				? `Candidate ${candidateId} archived. Leader ${leader.candidateId}: mean=${leader.searchScore?.meanScore.toFixed(3) ?? "0.000"} cost=${leader.searchScore?.totalCost.toFixed(3) ?? "0.000"} duration=${leader.searchScore?.totalDurationMs ?? 0}ms.`
				: `Candidate ${candidateId} archived.`;
			await saveQuestOptimizerState(cwd, state);
		} catch (error) {
			if (error instanceof EvalRunInterruptedError) {
				const partial = await materializeIncompleteCandidate(
					cwd,
					candidateId,
					nextProfile,
					proposal?.candidate?.patch,
					{
						candidateId,
						profileId: nextProfile?.id ?? currentProfile.id,
						createdAt: Date.now(),
						source: "proposer",
						status: "partial",
						summary: `Candidate ${candidateId} stopped during ${state.activeRun?.phase ?? "optimization"}.`,
						rationale: "Preserve interrupted optimization artifacts for inspection before continuing the frontier search.",
						generalizationNote: proposal?.candidate?.generalizationNote,
						targetedTags: proposal?.candidate?.targetedTags ?? [],
						promptSurfaceIds: proposal?.candidate?.promptSurfaceIds ?? [],
						searchScore,
						holdOutScore,
						paretoOptimal: false,
						failureReason: error.message,
					},
					searchScore,
					holdOutScore,
				);
				const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
				frontier = recomputed.frontier;
				leader = recomputed.leader;
				state.currentCandidateId = leader?.candidateId;
				state.frontierCandidateIds = frontier.frontierCandidateIds;
				state.status = "stopped";
				state.lastSummary = partial.summary;
				await saveQuestOptimizerState(cwd, state);
				break;
			}
			const failed = await materializeIncompleteCandidate(
				cwd,
				candidateId,
				nextProfile,
				proposal?.candidate?.patch,
				{
					candidateId,
					profileId: nextProfile?.id ?? currentProfile.id,
					createdAt: Date.now(),
					source: "proposer",
					status: "failed",
					summary: `Candidate ${candidateId} failed during ${state.activeRun?.phase ?? "optimization"}.`,
					rationale: "Preserve failed optimization artifacts while keeping incomplete candidates out of the frontier.",
					generalizationNote: proposal?.candidate?.generalizationNote,
					targetedTags: proposal?.candidate?.targetedTags ?? [],
					promptSurfaceIds: proposal?.candidate?.promptSurfaceIds ?? [],
					searchScore,
					holdOutScore,
					paretoOptimal: false,
					failureReason: error instanceof Error ? error.message : String(error),
				},
				searchScore,
				holdOutScore,
			);
			const recomputed = await recomputeFrontier(cwd, searchSet.family, searchSet.dataset);
			frontier = recomputed.frontier;
			leader = recomputed.leader;
			state.currentCandidateId = leader?.candidateId;
			state.frontierCandidateIds = frontier.frontierCandidateIds;
			state.status = "blocked";
			state.lastSummary = failed.summary;
			await saveQuestOptimizerState(cwd, state);
			throw error;
		} finally {
			state.activeRun = undefined;
			await saveQuestOptimizerState(cwd, state);
		}
	}

	if (state.status === "running") state.status = "idle";
	state.currentCandidateId = leader?.candidateId;
	state.frontierCandidateIds = frontier.frontierCandidateIds;
	await saveQuestOptimizerState(cwd, state);
	return {
		state,
		profile: currentProfile,
		summary: state.lastSummary ?? "Frontier eval run completed.",
		frontier,
		leader,
	};
}

export async function analyzeOptimizerCommunity(cwd: string, force = false, deps: FrontierOptimizerDependencies = {}): Promise<CommunityStats> {
	return ensureCommunityStats(cwd, deps, force);
}

export function summarizeOptimizerStatus(status: FrontierOptimizerStatus): string {
	const family = status.state.evalFamily ?? "frontierswe";
	const dataset = status.state.evalDataset ?? defaultDatasetForFamily(family);
	const runMode = status.state.evalRunMode ?? EVAL_ADAPTERS[family].resolveRunMode(dataset);
	const searchSummary = status.searchSet ? `${status.searchSet.totalItems} search` : "no search split";
	const holdOutSummary = status.holdOutSet ? `${status.holdOutSet.totalItems} hold-out` : "no hold-out split";
	const communitySummary = status.communityStats ? `${status.communityStats.parsedSessions}/${status.communityStats.totalSessions} community sessions` : "no community stats";
	const leaderFailureCategories = Object.entries((status.leader?.searchScore?.evalMetrics?.failureCategories as Record<string, number> | undefined) ?? {})
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 3)
		.map(([category, count]) => `${category}:${count}`)
		.join(", ");
	const leaderSummary = status.leader?.searchScore
		? `leader ${status.leader.candidateId} mean=${status.leader.searchScore.meanScore.toFixed(3)} cost=${status.leader.searchScore.totalCost.toFixed(3)} duration=${status.leader.searchScore.totalDurationMs}ms${leaderFailureCategories ? ` failures=${leaderFailureCategories}` : ""}`
		: "no frontier leader";
	return [
		`Evals status: ${status.state.status}`,
		`Eval: ${family}`,
		`Suite: ${dataset} (${runMode})`,
		`Profile: ${status.profile.id}`,
		`Split: ${searchSummary} / ${holdOutSummary}`,
		`Community: ${communitySummary}`,
		`Frontier: ${status.frontier?.frontierCandidateIds.length ?? 0} candidate(s), ${leaderSummary}`,
	].join("\n");
}
function unsupportedStoredSplitError(): Error {
	return new Error("Unsupported Quest eval split. Delete .pi/quests/evals/ and rerun `/quest evals prepare`.");
}
