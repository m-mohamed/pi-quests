import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	appendQuestEvent,
	createQuest,
	getQuestPaths,
	getQuestTelemetryPaths,
	listProjectQuests,
	listQuestTraceBundles,
	loadActiveQuest,
	loadLearnedWorkflows,
	loadQuest,
	projectIdFor,
	pruneQuestStorage,
	saveLearnedWorkflows,
	saveQuest,
	switchActiveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
} from "@m-mohamed/pi-quests-core/state-core";
import { defaultQuestProfile, normalizeQuestProfile } from "./profile-core.js";
import type { QuestOptimizerPaths, QuestOptimizerState, QuestProfile } from "./types.js";

const QUESTS_ROOT_DIR = ".pi/quests";
const EVALS_DIR = "evals";
const EVALS_STATE_FILE = "state.json";
const EVALS_CURRENT_DIR = "current";
const EVALS_CURRENT_PROFILE_FILE = "profile.json";
const EVALS_CANDIDATES_DIR = "candidates";
const EVALS_SEARCH_SET_FILE = "search-set.json";
const EVALS_HOLD_OUT_SET_FILE = "hold-out-set.json";
const EVALS_FRONTIER_FILE = "frontier.json";
const EVALS_COMMUNITY_STATS_FILE = "community-stats.json";
const EVALS_COMMUNITY_TRACES_DIR = "community-traces";
const EVALS_PROFILES_DIR = "profiles";
const STALE_OPTIMIZER_DIRS = ["datasets", "experiments", "baselines", "reports"] as const;
const OPTIMIZER_STORAGE_VERSION = 4;

async function writeAtomicFile(path: string, contents: string): Promise<void> {
	const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(tempPath, contents, "utf-8");
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

export {
	appendQuestEvent,
	createQuest,
	getQuestPaths,
	getQuestTelemetryPaths,
	listProjectQuests,
	listQuestTraceBundles,
	loadActiveQuest,
	loadLearnedWorkflows,
	loadQuest,
	projectIdFor,
	pruneQuestStorage,
	saveLearnedWorkflows,
	saveQuest,
	switchActiveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
};

export function getQuestOptimizerPaths(cwd: string): QuestOptimizerPaths {
	const questsRootDir = join(cwd, QUESTS_ROOT_DIR);
	const rootDir = join(questsRootDir, EVALS_DIR);
	return {
		rootDir,
		stateFile: join(rootDir, EVALS_STATE_FILE),
		currentDir: join(rootDir, EVALS_CURRENT_DIR),
		currentProfileFile: join(rootDir, EVALS_CURRENT_DIR, EVALS_CURRENT_PROFILE_FILE),
		candidatesDir: join(rootDir, EVALS_CANDIDATES_DIR),
		searchSetFile: join(rootDir, EVALS_SEARCH_SET_FILE),
		holdOutSetFile: join(rootDir, EVALS_HOLD_OUT_SET_FILE),
		frontierFile: join(rootDir, EVALS_FRONTIER_FILE),
		communityStatsFile: join(rootDir, EVALS_COMMUNITY_STATS_FILE),
		communityTracesDir: join(rootDir, EVALS_COMMUNITY_TRACES_DIR),
		profilesDir: join(rootDir, EVALS_PROFILES_DIR),
	};
}

async function ensureOptimizerRoot(cwd: string): Promise<QuestOptimizerPaths> {
	const paths = getQuestOptimizerPaths(cwd);
	await mkdir(paths.rootDir, { recursive: true });
	await mkdir(paths.currentDir, { recursive: true });
	await mkdir(paths.candidatesDir, { recursive: true });
	await mkdir(paths.communityTracesDir, { recursive: true });
	await mkdir(paths.profilesDir, { recursive: true });
	for (const legacyDir of STALE_OPTIMIZER_DIRS) {
		await rm(join(paths.rootDir, legacyDir), { recursive: true, force: true });
	}
	return paths;
}

function profileFile(paths: QuestOptimizerPaths, profileId: string): string {
	return join(paths.profilesDir, `${profileId}.json`);
}

function unsupportedOptimizerStateError(): Error {
	return new Error("Unsupported Quest eval state. Delete .pi/quests/evals/ and rerun `/quest evals prepare`.");
}

function defaultOptimizerState(cwd: string): QuestOptimizerState {
	const projectId = projectIdFor(cwd);
	return {
		projectId,
		target: "repo",
		activeProfileId: `repo-${projectId}`,
		storageVersion: OPTIMIZER_STORAGE_VERSION,
		evalFamily: "frontierswe",
		evalDataset: "frontierswe-sample@v1",
		evalRunMode: "sample",
		frontierCandidateIds: [],
		status: "idle",
		activeRun: undefined,
		updatedAt: Date.now(),
	};
}

export async function loadQuestOptimizerState(cwd: string, options: { ensure?: boolean } = {}): Promise<QuestOptimizerState> {
	const defaults = defaultOptimizerState(cwd);
	const paths = getQuestOptimizerPaths(cwd);
	if (options.ensure) await ensureOptimizerRoot(cwd);
	if (!existsSync(paths.stateFile)) {
		if (options.ensure) {
			await writeAtomicFile(paths.stateFile, `${JSON.stringify(defaults, null, 2)}\n`);
		}
		return defaults;
	}
	try {
		const raw = await readFile(paths.stateFile, "utf-8");
		const parsed = JSON.parse(raw) as Partial<QuestOptimizerState> & Record<string, unknown>;
		if (parsed.storageVersion !== OPTIMIZER_STORAGE_VERSION) {
			throw unsupportedOptimizerStateError();
		}
		return {
			...defaults,
			...parsed,
			projectId: defaults.projectId,
			activeProfileId: typeof parsed.activeProfileId === "string" && parsed.activeProfileId.trim() ? parsed.activeProfileId : defaults.activeProfileId,
			target: parsed.target === "quest-core" ? "quest-core" : defaults.target,
			storageVersion: OPTIMIZER_STORAGE_VERSION,
			evalFamily: parsed.evalFamily ?? defaults.evalFamily,
			evalDataset: typeof parsed.evalDataset === "string" && parsed.evalDataset.trim() ? parsed.evalDataset : defaults.evalDataset,
			evalRunMode: parsed.evalRunMode ?? defaults.evalRunMode,
			currentCandidateId: typeof parsed.currentCandidateId === "string" && parsed.currentCandidateId.trim() ? parsed.currentCandidateId : undefined,
			frontierCandidateIds: Array.isArray(parsed.frontierCandidateIds) ? parsed.frontierCandidateIds.map(String) : defaults.frontierCandidateIds,
			status: parsed.status ?? defaults.status,
			activeRun: parsed.activeRun
				? {
						candidateId: String(parsed.activeRun.candidateId),
						phase: parsed.activeRun.phase,
						pid: typeof parsed.activeRun.pid === "number" ? parsed.activeRun.pid : undefined,
						split: parsed.activeRun.split === "search" || parsed.activeRun.split === "hold-out" ? parsed.activeRun.split : undefined,
						startedAt:
							typeof parsed.activeRun.startedAt === "number" && Number.isFinite(parsed.activeRun.startedAt)
								? parsed.activeRun.startedAt
								: defaults.updatedAt,
					}
				: undefined,
			lastSummary: typeof parsed.lastSummary === "string" ? parsed.lastSummary : undefined,
			updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : defaults.updatedAt,
		};
	} catch {
		if (existsSync(paths.stateFile)) throw unsupportedOptimizerStateError();
		return defaults;
	}
}

export async function saveQuestOptimizerState(cwd: string, state: QuestOptimizerState): Promise<void> {
	const paths = await ensureOptimizerRoot(cwd);
	state.updatedAt = Date.now();
	state.storageVersion = OPTIMIZER_STORAGE_VERSION;
	await writeAtomicFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export async function loadQuestProfile(
	cwd: string,
	profileId?: string,
	options: { ensure?: boolean; target?: QuestOptimizerState["target"] } = {},
): Promise<QuestProfile> {
	const state = await loadQuestOptimizerState(cwd, { ensure: options.ensure });
	const resolvedProfileId = profileId ?? state.activeProfileId;
	const resolvedTarget = options.target ?? state.target;
	const internalProfiles = await import("./internal-profile-core.js");
	const defaults = internalProfiles.defaultInternalQuestProfile(projectIdFor(cwd), resolvedTarget);
	defaults.id = resolvedProfileId;
	const paths = getQuestOptimizerPaths(cwd);
	const file = resolvedProfileId === state.activeProfileId ? paths.currentProfileFile : profileFile(paths, resolvedProfileId);
	if (!existsSync(file)) {
		if (options.ensure) {
			await ensureOptimizerRoot(cwd);
			await writeAtomicFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
			if (file === paths.currentProfileFile) {
				await writeAtomicFile(profileFile(paths, defaults.id), `${JSON.stringify(defaults, null, 2)}\n`);
			}
		}
		return defaults;
	}
	try {
		const raw = await readFile(file, "utf-8");
		return internalProfiles.normalizeInternalQuestProfile(JSON.parse(raw) as Partial<QuestProfile>, projectIdFor(cwd), resolvedTarget);
	} catch {
		return defaults;
	}
}

export async function saveQuestProfile(cwd: string, profile: QuestProfile): Promise<void> {
	const paths = await ensureOptimizerRoot(cwd);
	const internalProfiles = await import("./internal-profile-core.js");
	const normalized = internalProfiles.normalizeInternalQuestProfile(profile, projectIdFor(cwd), profile.target);
	normalized.updatedAt = Date.now();
	await writeAtomicFile(profileFile(paths, normalized.id), `${JSON.stringify(normalized, null, 2)}\n`);
	await writeAtomicFile(paths.currentProfileFile, `${JSON.stringify(normalized, null, 2)}\n`);
	const state = await loadQuestOptimizerState(cwd, { ensure: true });
	state.activeProfileId = normalized.id;
	state.target = normalized.target;
	await saveQuestOptimizerState(cwd, state);
}

export async function listQuestProfiles(cwd: string): Promise<QuestProfile[]> {
	const paths = getQuestOptimizerPaths(cwd);
	if (!existsSync(paths.profilesDir)) return [];
	const internalProfiles = await import("./internal-profile-core.js");
	const entries = await readdir(paths.profilesDir);
	const profiles: QuestProfile[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(paths.profilesDir, entry), "utf-8");
			profiles.push(
				internalProfiles.normalizeInternalQuestProfile(JSON.parse(raw) as Partial<QuestProfile>, projectIdFor(cwd)),
			);
		} catch {
			continue;
		}
	}
	return profiles.sort((left, right) => right.updatedAt - left.updatedAt);
}
