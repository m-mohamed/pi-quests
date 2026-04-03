import type { LearnedWorkflow, ModelChoice, QuestEventRecord, QuestState, WorkerRunRecord } from "./types.js";
import {
	appendQuestEvent as appendQuestEventCore,
	createQuest as createQuestCore,
	getQuestPaths,
	loadActiveQuest as loadActiveQuestCore,
	loadLearnedWorkflows as loadLearnedWorkflowsCore,
	listProjectQuests as listProjectQuestsCore,
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

export { getQuestPaths };

export async function setActiveQuestId(cwd: string, questId: string | null): Promise<void> {
	return setActiveQuestIdCore(cwd, questId);
}

export async function saveQuest(quest: QuestState): Promise<void> {
	return saveQuestCore(quest);
}

export async function appendQuestEvent(cwd: string, questId: string, event: QuestEventRecord): Promise<void> {
	return appendQuestEventCore(cwd, questId, event);
}

export async function writeWorkerRun(cwd: string, questId: string, record: WorkerRunRecord): Promise<void> {
	return writeWorkerRunCore(cwd, questId, record);
}

export async function loadQuest(cwd: string, questId: string): Promise<QuestState | null> {
	return loadQuestCore(cwd, questId);
}

export async function loadActiveQuest(cwd: string): Promise<QuestState | null> {
	return loadActiveQuestCore(cwd);
}

export async function listProjectQuests(cwd: string): Promise<QuestState[]> {
	return listProjectQuestsCore(cwd);
}

export async function createQuest(cwd: string, goal: string, defaultModel: ModelChoice): Promise<QuestState> {
	return createQuestCore(cwd, goal, defaultModel);
}

export async function switchActiveQuest(cwd: string, questId: string): Promise<QuestState | null> {
	return switchActiveQuestCore(cwd, questId);
}

export async function pruneQuestStorage(cwd: string, now = Date.now()): Promise<{ prunedLogs: number; deletedRuns: number }> {
	return pruneQuestStorageCore(cwd, now);
}

export async function loadLearnedWorkflows(cwd: string): Promise<LearnedWorkflow[]> {
	return loadLearnedWorkflowsCore(cwd);
}

export async function saveLearnedWorkflows(cwd: string, workflows: LearnedWorkflow[]): Promise<void> {
	return saveLearnedWorkflowsCore(cwd, workflows);
}

export async function questDirStats(cwd: string, questId: string) {
	return questDirStatsCore(cwd, questId);
}

export async function questAgeMs(cwd: string, questId: string) {
	return questAgeMsCore(cwd, questId);
}

export { questIsTerminal, projectIdFor, trimRecentRuns };
