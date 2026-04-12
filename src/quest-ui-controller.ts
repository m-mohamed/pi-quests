import { type ContextUsage, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { internalModeEnabled } from "./internal-mode.js";
import { formatContextUsageLabel } from "./extension-core.js";
import {
	buildQuestWidgetModel,
	createQuestModeWidgetComponent,
	createQuestWidgetComponent,
} from "./ui-core.js";
import type { InternalUiModule } from "./quest-internal-loader.js";
import type { LiveRunSnapshot, QuestState, QuestTrialState } from "./types.js";

export function applyTransientUiState(
	ctx: ExtensionContext,
	quest: QuestState | null,
	state: {
		currentTrialState: QuestTrialState | null;
		liveRun: LiveRunSnapshot | null;
		trialLiveRun: LiveRunSnapshot | null;
	},
) {
	if (!ctx.hasUI) return;
	if (quest && state.liveRun) {
		const working = `Quest ${state.liveRun.role} · ${state.liveRun.phase}${state.liveRun.latestToolName ? ` · ${state.liveRun.latestToolName}` : ""}`;
		ctx.ui.setWorkingMessage(working);
		ctx.ui.setHiddenThinkingLabel(`quest:${state.liveRun.role}`);
		return;
	}
	if (!quest && state.currentTrialState?.status === "running" && state.trialLiveRun) {
		const working = `Trials ${state.trialLiveRun.phase}${state.trialLiveRun.latestToolName ? ` · ${state.trialLiveRun.latestToolName}` : ""}`;
		ctx.ui.setWorkingMessage(working);
		ctx.ui.setHiddenThinkingLabel("quest:trials");
		return;
	}
	ctx.ui.setWorkingMessage();
	ctx.ui.setHiddenThinkingLabel();
}

export async function applyQuestUi(
	ctx: ExtensionContext,
	quest: QuestState | null,
	options: {
		statusKey: string;
		widgetKey: string;
		questModeEnabled: boolean;
		lastContextUsage: ContextUsage | null;
		currentTrialState: QuestTrialState | null;
		liveRun: LiveRunSnapshot | null;
		trialLiveRun: LiveRunSnapshot | null;
		loadInternalUi: () => Promise<InternalUiModule>;
	},
) {
	if (!ctx.hasUI) return;
	const contextLabel = formatContextUsageLabel(options.lastContextUsage);
	applyTransientUiState(ctx, quest, {
		currentTrialState: options.currentTrialState,
		liveRun: options.liveRun,
		trialLiveRun: options.trialLiveRun,
	});
	if (!quest) {
		if (options.questModeEnabled) {
			ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `quest:mode${contextLabel ? ` · ${contextLabel}` : ""}`));
			ctx.ui.setWidget(options.widgetKey, createQuestModeWidgetComponent(contextLabel));
		} else if (internalModeEnabled() && options.currentTrialState?.status === "running") {
			const trialState = options.currentTrialState;
			try {
				const internalUi = await options.loadInternalUi();
				ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `trials:${trialState.status}${contextLabel ? ` · ${contextLabel}` : ""}`));
				ctx.ui.setWidget(
					options.widgetKey,
					internalUi.createTrialsWidgetComponent(
						internalUi.buildTrialsWidgetModel(trialState, trialState.activeProfileId, options.trialLiveRun, contextLabel),
					),
				);
			} catch {
				ctx.ui.setStatus(options.statusKey, undefined);
				ctx.ui.setWidget(options.widgetKey, undefined);
			}
		} else {
			ctx.ui.setStatus(options.statusKey, undefined);
			ctx.ui.setWidget(options.widgetKey, undefined);
		}
		return;
	}
	const liveSummary = options.liveRun ? ` · ${options.liveRun.role}:${options.liveRun.phase}` : "";
	ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `quest:${quest.status}${liveSummary}${contextLabel ? ` · ${contextLabel}` : ""}`));
	ctx.ui.setWidget(
		options.widgetKey,
		createQuestWidgetComponent(buildQuestWidgetModel(quest, options.liveRun, options.questModeEnabled, contextLabel)),
	);
}

export function summarizeTrials(summary: string, trialLiveRun: LiveRunSnapshot | null): string {
	return `# Trials

${summary}

Active trial run:
${
		trialLiveRun
			? `${trialLiveRun.role}/${trialLiveRun.phase}${trialLiveRun.latestToolName ? ` · ${trialLiveRun.latestToolName}` : ""}${trialLiveRun.latestMessage ? ` · ${trialLiveRun.latestMessage.slice(0, 80)}` : ""}`
			: "idle"
	}`;
}
