import { assertInternalMode } from "./internal-mode.js";
import { defaultInternalQuestProfile } from "./internal-profile-core.js";
import { loadQuestProfile, loadQuestTrialState } from "./state.js";
import {
	DEFAULT_HEADLESS_EXECUTORS,
	runQuestHeadlessExecution,
	type QuestHeadlessExecutionInput,
	type QuestHeadlessExecutionResult,
	type QuestHeadlessExecutors,
} from "./headless-runner-core.js";
import type { QuestBenchmarkProvenance } from "./types.js";

export interface QuestInternalHeadlessRunInput extends QuestHeadlessExecutionInput {
	profileId?: string;
	benchmark?: Omit<QuestBenchmarkProvenance, "recordedAt" | "model">;
}

export type QuestInternalHeadlessRunResult = QuestHeadlessExecutionResult;
export type { QuestHeadlessExecutors };

export async function runInternalQuestHeadless(
	input: QuestInternalHeadlessRunInput,
	executors: QuestHeadlessExecutors = DEFAULT_HEADLESS_EXECUTORS,
): Promise<QuestInternalHeadlessRunResult> {
	assertInternalMode("Internal Quest headless surfaces");
	return runQuestHeadlessExecution(
		input,
		{
			resolveProfile: async ({ cwd }) => {
				const trialState = await loadQuestTrialState(cwd, { ensure: true });
				return (
					(await loadQuestProfile(cwd, input.profileId ?? trialState.activeProfileId, {
						ensure: true,
						target: trialState.target,
					})) ?? defaultInternalQuestProfile(trialState.projectId, trialState.target)
				);
			},
		},
		executors,
	);
}
