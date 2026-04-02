import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	LearnedWorkflow,
	ModelChoice,
	QuestEventRecord,
	QuestPlanRevision,
	QuestState,
	QuestStatus,
	QuestStoragePaths,
	WorkerRunRecord,
} from "./types.js";

const ACTIVE_FILE = "active.json";
const QUESTS_ROOT_DIR = "quests";
const QUEST_FILE = "quest.json";
const EVENTS_FILE = "events.jsonl";
const WORKERS_DIR = "workers";
const PROJECTS_METADATA_DIR = "projects";
const WORKFLOWS_DIR = "workflows";
const WORKFLOWS_FILE = "learned-workflows.json";
const PRUNE_LOG_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const TERMINAL_STATUSES = new Set<QuestStatus>(["completed", "failed", "aborted"]);

export function projectIdFor(cwd: string): string {
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
	const name = basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
	return `${name}-${hash}`;
}

function storagePathsFor(agentDir: string, cwd: string, questId: string, rootDirName: string, questFileName: string): QuestStoragePaths {
	const rootDir = join(agentDir, rootDirName);
	const projectId = projectIdFor(cwd);
	const projectDir = join(rootDir, projectId);
	const questDir = join(projectDir, questId);
	const projectMetadataRoot = join(rootDir, PROJECTS_METADATA_DIR);
	const projectMetadataDir = join(projectMetadataRoot, projectId);
	const projectWorkflowsDir = join(projectMetadataDir, WORKFLOWS_DIR);

	return {
		rootDir,
		projectDir,
		activeFile: join(projectDir, ACTIVE_FILE),
		questDir,
		questFile: join(questDir, questFileName),
		eventsFile: join(questDir, EVENTS_FILE),
		workersDir: join(questDir, WORKERS_DIR),
		projectMetadataRoot,
		projectMetadataDir,
		projectWorkflowsDir,
		projectWorkflowsFile: join(projectWorkflowsDir, WORKFLOWS_FILE),
	};
}

export function getQuestPathsFromAgentDir(agentDir: string, cwd: string, questId: string): QuestStoragePaths {
	return storagePathsFor(agentDir, cwd, questId, QUESTS_ROOT_DIR, QUEST_FILE);
}

async function ensureProjectDir(agentDir: string, cwd: string): Promise<QuestStoragePaths> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, "__bootstrap__");
	await mkdir(paths.projectDir, { recursive: true });
	await mkdir(paths.projectWorkflowsDir, { recursive: true });
	return paths;
}

async function ensureQuestDir(agentDir: string, cwd: string, questId: string): Promise<QuestStoragePaths> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, questId);
	await mkdir(paths.projectDir, { recursive: true });
	await mkdir(paths.questDir, { recursive: true });
	await mkdir(paths.workersDir, { recursive: true });
	await mkdir(paths.projectWorkflowsDir, { recursive: true });
	return paths;
}

export async function setActiveQuestId(agentDir: string, cwd: string, questId: string | null): Promise<void> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, "__bootstrap__");
	if (!questId) {
		if (existsSync(paths.activeFile)) await unlink(paths.activeFile);
		return;
	}
	await mkdir(paths.projectDir, { recursive: true });
	await writeFile(paths.activeFile, `${JSON.stringify({ questId })}\n`, "utf-8");
}

export async function getActiveQuestId(agentDir: string, cwd: string): Promise<string | null> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, "__bootstrap__");
	if (!existsSync(paths.activeFile)) return null;
	try {
		const raw = await readFile(paths.activeFile, "utf-8");
		const parsed = JSON.parse(raw) as { questId?: string };
		return parsed.questId ?? null;
	} catch {
		return null;
	}
}

export async function saveQuest(agentDir: string, quest: QuestState): Promise<void> {
	const paths = await ensureQuestDir(agentDir, quest.cwd, quest.id);
	quest.updatedAt = Date.now();
	await writeFile(paths.questFile, `${JSON.stringify(quest, null, 2)}\n`, "utf-8");
}

export async function appendQuestEvent(agentDir: string, cwd: string, questId: string, event: QuestEventRecord): Promise<void> {
	const paths = await ensureQuestDir(agentDir, cwd, questId);
	await writeFile(paths.eventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf-8", flag: "a" });
}

export async function writeWorkerRun(agentDir: string, cwd: string, questId: string, record: WorkerRunRecord): Promise<void> {
	const paths = await ensureQuestDir(agentDir, cwd, questId);
	const file = join(paths.workersDir, `${record.startedAt}-${record.role}-${record.id}.json`);
	await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

export async function loadQuest(agentDir: string, cwd: string, questId: string): Promise<QuestState | null> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, questId);
	if (!existsSync(paths.questFile)) return null;
	try {
		const raw = await readFile(paths.questFile, "utf-8");
		return JSON.parse(raw) as QuestState;
	} catch {
		return null;
	}
}

export async function loadActiveQuest(agentDir: string, cwd: string): Promise<QuestState | null> {
	const questId = await getActiveQuestId(agentDir, cwd);
	if (!questId) return null;
	return loadQuest(agentDir, cwd, questId);
}

function initialPlanRevision(): QuestPlanRevision[] {
	return [];
}

export async function createQuest(agentDir: string, cwd: string, goal: string, defaultModel: ModelChoice): Promise<QuestState> {
	const questId = randomUUID();
	const quest: QuestState = {
		id: questId,
		projectId: projectIdFor(cwd),
		cwd,
		title: goal,
		goal,
		status: "planning",
		defaultModel,
		roleModels: {},
		planRevisions: initialPlanRevision(),
		pendingPlanRevisionRequests: [],
		steeringNotes: [],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
	await saveQuest(agentDir, quest);
	await setActiveQuestId(agentDir, cwd, questId);
	await appendQuestEvent(agentDir, cwd, questId, { ts: Date.now(), type: "quest_created", data: { goal } });
	return quest;
}

export function questIsTerminal(quest: QuestState): boolean {
	return TERMINAL_STATUSES.has(quest.status);
}

export async function switchActiveQuest(agentDir: string, cwd: string, questId: string): Promise<QuestState | null> {
	const quest = await loadQuest(agentDir, cwd, questId);
	if (!quest) return null;
	await setActiveQuestId(agentDir, cwd, questId);
	return quest;
}

async function listProjectDirs(rootDir: string): Promise<string[]> {
	if (!existsSync(rootDir)) return [];
	const entries = await readdir(rootDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory() && entry.name !== PROJECTS_METADATA_DIR)
		.map((entry) => join(rootDir, entry.name));
}

async function listQuestDirs(projectDir: string): Promise<string[]> {
	const entries = await readdir(projectDir, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectDir, entry.name));
}

export async function pruneQuestStorage(agentDir: string, now = Date.now()): Promise<{ prunedLogs: number; deletedRuns: number }> {
	let prunedLogs = 0;
	let deletedRuns = 0;

	const rootDir = join(agentDir, QUESTS_ROOT_DIR);
	for (const projectDir of await listProjectDirs(rootDir)) {
		for (const questDir of await listQuestDirs(projectDir)) {
			const questFile = join(questDir, QUEST_FILE);
			if (!existsSync(questFile)) continue;

			let quest: QuestState | null = null;
			try {
				quest = JSON.parse(await readFile(questFile, "utf-8")) as QuestState;
			} catch {
				continue;
			}
			if (!quest || !TERMINAL_STATUSES.has(quest.status) || quest.prunedAt) continue;
			if (now - quest.updatedAt < PRUNE_LOG_AGE_MS) continue;

			const eventsFile = join(questDir, EVENTS_FILE);
			if (existsSync(eventsFile)) {
				await unlink(eventsFile);
				prunedLogs++;
			}

			const workersDir = join(questDir, WORKERS_DIR);
			if (existsSync(workersDir)) {
				const entries = await readdir(workersDir);
				deletedRuns += entries.length;
				await rm(workersDir, { recursive: true, force: true });
			}

			quest.prunedAt = now;
			quest.updatedAt = now;
			await writeFile(questFile, `${JSON.stringify(quest, null, 2)}\n`, "utf-8");
		}
	}

	return { prunedLogs, deletedRuns };
}

export function trimRecentRuns<T extends { startedAt: number }>(runs: T[], max = 12): T[] {
	return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, max);
}

export async function loadLearnedWorkflows(agentDir: string, cwd: string): Promise<LearnedWorkflow[]> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, "__bootstrap__");
	if (!existsSync(paths.projectWorkflowsFile)) return [];
	try {
		const raw = await readFile(paths.projectWorkflowsFile, "utf-8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as LearnedWorkflow[];
	} catch {
		return [];
	}
	return [];
}

export async function saveLearnedWorkflows(agentDir: string, cwd: string, workflows: LearnedWorkflow[]): Promise<void> {
	const paths = await ensureProjectDir(agentDir, cwd);
	await writeFile(paths.projectWorkflowsFile, `${JSON.stringify(workflows, null, 2)}\n`, "utf-8");
}

export async function questDirStats(agentDir: string, cwd: string, questId: string): Promise<{ hasEvents: boolean; runFiles: number }> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, questId);
	if (!existsSync(paths.questFile)) return { hasEvents: false, runFiles: 0 };
	const hasEvents = existsSync(paths.eventsFile);
	let runFiles = 0;
	if (existsSync(paths.workersDir)) runFiles = (await readdir(paths.workersDir)).length;
	return { hasEvents, runFiles };
}

export async function questAgeMs(agentDir: string, cwd: string, questId: string): Promise<number | null> {
	const paths = getQuestPathsFromAgentDir(agentDir, cwd, questId);
	if (!existsSync(paths.questFile)) return null;
	const stats = await stat(paths.questFile);
	return Date.now() - stats.mtimeMs;
}
