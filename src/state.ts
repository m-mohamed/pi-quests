import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
	LearnedWorkflow,
	ModelChoice,
	QuestEventRecord,
	QuestState,
	WorkerRunRecord,
} from "./types.js";
import {
	appendQuestEvent as appendQuestEventCore,
	createQuest as createQuestCore,
	getQuestPathsFromAgentDir,
	loadActiveQuest as loadActiveQuestCore,
	loadLearnedWorkflows as loadLearnedWorkflowsCore,
	loadQuest as loadQuestCore,
	questAgeMs as questAgeMsCore,
	questDirStats as questDirStatsCore,
	questIsTerminal,
	projectIdFor,
	pruneQuestStorage as pruneQuestStorageCore,
	saveLearnedWorkflows as saveLearnedWorkflowsCore,
	saveQuest as saveQuestCore,
	setActiveQuestId as setActiveQuestIdCore,
	switchActiveQuest as switchActiveQuestCore,
	trimRecentRuns,
	writeWorkerRun as writeWorkerRunCore,
} from "./state-core.js";

function agentDir(): string {
	return getAgentDir();
}

export function getQuestPaths(cwd: string, questId: string) {
	return getQuestPathsFromAgentDir(agentDir(), cwd, questId);
}

export async function setActiveQuestId(cwd: string, questId: string | null): Promise<void> {
	return setActiveQuestIdCore(agentDir(), cwd, questId);
}

export async function saveQuest(quest: QuestState): Promise<void> {
	return saveQuestCore(agentDir(), quest);
}

export async function appendQuestEvent(cwd: string, questId: string, event: QuestEventRecord): Promise<void> {
	return appendQuestEventCore(agentDir(), cwd, questId, event);
}

export async function writeWorkerRun(cwd: string, questId: string, record: WorkerRunRecord): Promise<void> {
	return writeWorkerRunCore(agentDir(), cwd, questId, record);
}

export async function loadQuest(cwd: string, questId: string): Promise<QuestState | null> {
	return loadQuestCore(agentDir(), cwd, questId);
}

export async function loadActiveQuest(cwd: string): Promise<QuestState | null> {
	return loadActiveQuestCore(agentDir(), cwd);
}

export async function createQuest(cwd: string, goal: string, defaultModel: ModelChoice): Promise<QuestState> {
	return createQuestCore(agentDir(), cwd, goal, defaultModel);
}

export async function switchActiveQuest(cwd: string, questId: string): Promise<QuestState | null> {
	return switchActiveQuestCore(agentDir(), cwd, questId);
}

export async function pruneQuestStorage(now = Date.now()): Promise<{ prunedLogs: number; deletedRuns: number }> {
	return pruneQuestStorageCore(agentDir(), now);
}

export async function loadLearnedWorkflows(cwd: string): Promise<LearnedWorkflow[]> {
	return loadLearnedWorkflowsCore(agentDir(), cwd);
}

export async function saveLearnedWorkflows(cwd: string, workflows: LearnedWorkflow[]): Promise<void> {
	return saveLearnedWorkflowsCore(agentDir(), cwd, workflows);
}

export async function questDirStats(cwd: string, questId: string) {
	return questDirStatsCore(agentDir(), cwd, questId);
}

export async function questAgeMs(cwd: string, questId: string) {
	return questAgeMsCore(agentDir(), cwd, questId);
}

export { questIsTerminal, projectIdFor, trimRecentRuns };
