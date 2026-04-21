import { defaultQuestProfile } from "./profile-core.js";
import { loadQuestProfile, loadQuestOptimizerState, projectIdFor } from "./state-core.js";
import type { QuestProfile, QuestOptimizerState } from "./types.js";

export type FrontierOptimizerModule = typeof import("./frontier-optimizer.js");
export type FrontierOptimizerStatus = Awaited<ReturnType<FrontierOptimizerModule["collectFrontierOptimizerStatus"]>>;
export type InternalUiModule = typeof import("./internal-ui.js");

let frontierOptimizerModulePromise: Promise<FrontierOptimizerModule> | null = null;
let internalUiModulePromise: Promise<InternalUiModule> | null = null;

export async function loadFrontierOptimizer(): Promise<FrontierOptimizerModule> {
	frontierOptimizerModulePromise ??= import("./frontier-optimizer.js").catch((error) => {
		throw new Error(`Internal Quest optimizer surfaces require the repo checkout. ${error instanceof Error ? error.message : String(error)}`);
	});
	return frontierOptimizerModulePromise;
}

export async function loadInternalUi(): Promise<InternalUiModule> {
	internalUiModulePromise ??= import("./internal-ui.js").catch((error) => {
		throw new Error(`Internal Quest optimizer UI requires the repo checkout. ${error instanceof Error ? error.message : String(error)}`);
	});
	return internalUiModulePromise;
}

export async function loadRuntimeProfile(
	cwd: string,
	options?: { ensure?: boolean; profileId?: string; target?: QuestOptimizerState["target"] },
): Promise<{ optimizerState: QuestOptimizerState | null; profile: QuestProfile }> {
	const optimizerState = await loadQuestOptimizerState(cwd, options?.ensure ? { ensure: true } : undefined);
	const profile =
		(await loadQuestProfile(cwd, options?.profileId ?? optimizerState.activeProfileId, {
			ensure: options?.ensure,
			target: options?.target ?? optimizerState.target,
		})) ?? defaultQuestProfile(optimizerState.projectId, options?.target ?? optimizerState.target);
	return { optimizerState, profile };
}
