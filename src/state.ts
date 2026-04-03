import type {
	LearnedWorkflow,
	ModelChoice,
	QuestEvalDataset,
	QuestEventRecord,
	QuestExperiment,
	QuestTrialState,
	QuestProfile,
	QuestState,
	QuestTraceBundle,
	WorkerRunRecord,
} from "./types.js";
import {
	appendQuestEvent as appendQuestEventCore,
	createQuest as createQuestCore,
	getQuestTrialPaths,
	getQuestPaths,
	loadActiveQuest as loadActiveQuestCore,
	loadQuestEvalDataset as loadQuestEvalDatasetCore,
	loadQuestExperiment as loadQuestExperimentCore,
	loadQuestTrialState as loadQuestTrialStateCore,
	loadLearnedWorkflows as loadLearnedWorkflowsCore,
	loadQuestProfile as loadQuestProfileCore,
	listQuestEvalDatasets as listQuestEvalDatasetsCore,
	listQuestExperiments as listQuestExperimentsCore,
	listProjectQuests as listProjectQuestsCore,
	listQuestProfiles as listQuestProfilesCore,
	listQuestTraceBundles as listQuestTraceBundlesCore,
	loadQuest as loadQuestCore,
	questAgeMs as questAgeMsCore,
	questDirStats as questDirStatsCore,
	questIsTerminal,
	projectIdFor,
	pruneQuestStorage as pruneQuestStorageCore,
	saveLearnedWorkflows as saveLearnedWorkflowsCore,
	saveQuestBaselineProfile as saveQuestBaselineProfileCore,
	saveQuestEvalDataset as saveQuestEvalDatasetCore,
	saveQuestExperiment as saveQuestExperimentCore,
	saveQuestTrialReport as saveQuestTrialReportCore,
	saveQuestTrialState as saveQuestTrialStateCore,
	saveQuestProfile as saveQuestProfileCore,
	saveQuest as saveQuestCore,
	setActiveQuestId as setActiveQuestIdCore,
	switchActiveQuest as switchActiveQuestCore,
	trimRecentRuns,
	writeQuestTraceBundle as writeQuestTraceBundleCore,
	writeWorkerRun as writeWorkerRunCore,
} from "./state-core.js";

export { getQuestPaths, getQuestTrialPaths };

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

export async function loadQuestTrialState(cwd: string, options?: { ensure?: boolean }): Promise<QuestTrialState> {
	return loadQuestTrialStateCore(cwd, options);
}

export async function saveQuestTrialState(cwd: string, state: QuestTrialState): Promise<void> {
	return saveQuestTrialStateCore(cwd, state);
}

export async function loadQuestProfile(
	cwd: string,
	profileId?: string,
	options?: { ensure?: boolean; target?: QuestProfile["target"] },
): Promise<QuestProfile> {
	return loadQuestProfileCore(cwd, profileId, options);
}

export async function saveQuestProfile(cwd: string, profile: QuestProfile): Promise<void> {
	return saveQuestProfileCore(cwd, profile);
}

export async function listQuestProfiles(cwd: string): Promise<QuestProfile[]> {
	return listQuestProfilesCore(cwd);
}

export async function writeQuestTraceBundle(cwd: string, trace: QuestTraceBundle): Promise<string> {
	return writeQuestTraceBundleCore(cwd, trace);
}

export async function listQuestTraceBundles(cwd: string, limit?: number): Promise<QuestTraceBundle[]> {
	return listQuestTraceBundlesCore(cwd, limit);
}

export async function loadQuestEvalDataset(cwd: string, datasetId: string): Promise<QuestEvalDataset | null> {
	return loadQuestEvalDatasetCore(cwd, datasetId);
}

export async function saveQuestEvalDataset(cwd: string, dataset: QuestEvalDataset): Promise<void> {
	return saveQuestEvalDatasetCore(cwd, dataset);
}

export async function listQuestEvalDatasets(cwd: string): Promise<QuestEvalDataset[]> {
	return listQuestEvalDatasetsCore(cwd);
}

export async function saveQuestExperiment(cwd: string, experiment: QuestExperiment): Promise<void> {
	return saveQuestExperimentCore(cwd, experiment);
}

export async function loadQuestExperiment(cwd: string, experimentId: string): Promise<QuestExperiment | null> {
	return loadQuestExperimentCore(cwd, experimentId);
}

export async function listQuestExperiments(cwd: string, limit?: number): Promise<QuestExperiment[]> {
	return listQuestExperimentsCore(cwd, limit);
}

export async function saveQuestBaselineProfile(cwd: string, experimentId: string, profile: QuestProfile): Promise<string> {
	return saveQuestBaselineProfileCore(cwd, experimentId, profile);
}

export async function saveQuestTrialReport(cwd: string, reportId: string, payload: unknown): Promise<string> {
	return saveQuestTrialReportCore(cwd, reportId, payload);
}

export async function questDirStats(cwd: string, questId: string) {
	return questDirStatsCore(cwd, questId);
}

export async function questAgeMs(cwd: string, questId: string) {
	return questAgeMsCore(cwd, questId);
}

export { questIsTerminal, projectIdFor, trimRecentRuns };
