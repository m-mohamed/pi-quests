import { defaultInternalQuestProfile } from "./internal-profile-core.js";
import { loadQuestProfile, loadQuestOptimizerState } from "./state-core.js";
import {
	DEFAULT_HEADLESS_EXECUTORS,
	runQuestHeadlessExecution,
	type QuestHeadlessExecutionInput,
	type QuestHeadlessExecutionResult,
	type QuestHeadlessExecutors,
} from "./headless-runner-core.js";
import type { QuestEvalProvenance } from "./types.js";

export interface QuestInternalHeadlessRunInput extends QuestHeadlessExecutionInput {
	profileId?: string;
	evaluation?: Omit<QuestEvalProvenance, "recordedAt" | "model">;
}

export type QuestInternalHeadlessRunResult = QuestHeadlessExecutionResult;
export type { QuestHeadlessExecutors };

export async function runInternalQuestHeadless(
	input: QuestInternalHeadlessRunInput,
	executors: QuestHeadlessExecutors = DEFAULT_HEADLESS_EXECUTORS,
): Promise<QuestInternalHeadlessRunResult> {
	return runQuestHeadlessExecution(
		input,
		{
			resolveProfile: async ({ cwd }) => {
				const optimizerState = await loadQuestOptimizerState(cwd, { ensure: true });
				return (
					(await loadQuestProfile(cwd, input.profileId ?? optimizerState.activeProfileId, {
						ensure: true,
						target: optimizerState.target,
					})) ?? defaultInternalQuestProfile(optimizerState.projectId, optimizerState.target)
				);
			},
		},
		executors,
	);
}
