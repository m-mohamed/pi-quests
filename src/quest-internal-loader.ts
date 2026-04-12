import { internalModeEnabled } from "./internal-mode.js";
import { defaultQuestProfile } from "./profile-core.js";
import { loadQuestProfile, loadQuestTrialState, projectIdFor } from "./state.js";
import type { QuestProfile, QuestTrialState } from "./types.js";

export type FrontierTrialsModule = typeof import("./frontier-trials.js");
export type FrontierTrialStatus = Awaited<ReturnType<FrontierTrialsModule["collectFrontierTrialStatus"]>>;
export type InternalUiModule = typeof import("./internal-ui.js");

let frontierTrialsModulePromise: Promise<FrontierTrialsModule> | null = null;
let internalUiModulePromise: Promise<InternalUiModule> | null = null;

export async function loadFrontierTrials(): Promise<FrontierTrialsModule> {
	frontierTrialsModulePromise ??= import("./frontier-trials.js").catch((error) => {
		throw new Error(`Internal Quest optimizer surfaces require the repo checkout. ${error instanceof Error ? error.message : String(error)}`);
	});
	return frontierTrialsModulePromise;
}

export async function loadInternalUi(): Promise<InternalUiModule> {
	internalUiModulePromise ??= import("./internal-ui.js").catch((error) => {
		throw new Error(`Internal Quest optimizer UI requires the repo checkout. ${error instanceof Error ? error.message : String(error)}`);
	});
	return internalUiModulePromise;
}

export async function loadRuntimeProfile(
	cwd: string,
	options?: { ensure?: boolean; profileId?: string; target?: QuestTrialState["target"] },
): Promise<{ trialState: QuestTrialState | null; profile: QuestProfile }> {
	if (!internalModeEnabled()) {
		return {
			trialState: null,
			profile: defaultQuestProfile(projectIdFor(cwd), options?.target ?? "repo"),
		};
	}
	const trialState = await loadQuestTrialState(cwd, options?.ensure ? { ensure: true } : undefined);
	const profile =
		(await loadQuestProfile(cwd, options?.profileId ?? trialState.activeProfileId, {
			ensure: options?.ensure,
			target: options?.target ?? trialState.target,
		})) ?? defaultQuestProfile(trialState.projectId, options?.target ?? trialState.target);
	return { trialState, profile };
}
