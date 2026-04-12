import { defaultQuestProfile } from "./profile-core.js";
import { projectIdFor } from "./state.js";
import {
	DEFAULT_HEADLESS_EXECUTORS,
	runQuestHeadlessExecution,
	type QuestHeadlessExecutionInput,
	type QuestHeadlessExecutionResult,
	type QuestHeadlessExecutors,
} from "./headless-runner-core.js";

export interface QuestHeadlessRunInput extends QuestHeadlessExecutionInput {
	benchmark?: never;
}

export type QuestHeadlessRunResult = QuestHeadlessExecutionResult;
export type { QuestHeadlessExecutors };

export async function runQuestHeadless(
	input: QuestHeadlessRunInput,
	executors: QuestHeadlessExecutors = DEFAULT_HEADLESS_EXECUTORS,
): Promise<QuestHeadlessRunResult> {
	return runQuestHeadlessExecution(
		input,
		{
			resolveProfile: async ({ cwd }) => defaultQuestProfile(projectIdFor(cwd), "repo"),
		},
		executors,
	);
}
