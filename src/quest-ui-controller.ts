import { type ContextUsage, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { internalModeEnabled } from "./internal-mode.js";
import { formatContextUsageLabel } from "./extension-core.js";
import {
	buildQuestWidgetModel,
	createQuestModeWidgetComponent,
	createQuestWidgetComponent,
} from "./ui-core.js";
import type { InternalUiModule } from "./quest-internal-loader.js";
import type { LiveRunSnapshot, QuestState, QuestOptimizerState } from "./types.js";

export function applyTransientUiState(
	ctx: ExtensionContext,
	quest: QuestState | null,
	state: {
		currentOptimizerState: QuestOptimizerState | null;
		liveRun: LiveRunSnapshot | null;
		optimizerLiveRun: LiveRunSnapshot | null;
	},
) {
	if (!ctx.hasUI) return;
	if (quest && state.liveRun) {
		const working = `Quest ${state.liveRun.role} · ${state.liveRun.phase}${state.liveRun.latestToolName ? ` · ${state.liveRun.latestToolName}` : ""}`;
		ctx.ui.setWorkingMessage(working);
		ctx.ui.setHiddenThinkingLabel(`quest:${state.liveRun.role}`);
		return;
	}
	if (!quest && state.currentOptimizerState?.status === "running" && state.optimizerLiveRun) {
		const working = `Evals ${state.optimizerLiveRun.phase}${state.optimizerLiveRun.latestToolName ? ` · ${state.optimizerLiveRun.latestToolName}` : ""}`;
		ctx.ui.setWorkingMessage(working);
		ctx.ui.setHiddenThinkingLabel("quest:evals");
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
		currentOptimizerState: QuestOptimizerState | null;
		liveRun: LiveRunSnapshot | null;
		optimizerLiveRun: LiveRunSnapshot | null;
		loadInternalUi: () => Promise<InternalUiModule>;
	},
) {
	if (!ctx.hasUI) return;
	const contextLabel = formatContextUsageLabel(options.lastContextUsage);
	applyTransientUiState(ctx, quest, {
		currentOptimizerState: options.currentOptimizerState,
		liveRun: options.liveRun,
		optimizerLiveRun: options.optimizerLiveRun,
	});
	if (!quest) {
		if (options.questModeEnabled) {
			ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `quest:mode${contextLabel ? ` · ${contextLabel}` : ""}`));
			ctx.ui.setWidget(options.widgetKey, createQuestModeWidgetComponent(contextLabel));
		} else if (internalModeEnabled() && options.currentOptimizerState?.status === "running") {
			const optimizerState = options.currentOptimizerState;
			try {
				const internalUi = await options.loadInternalUi();
				ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `evals:${optimizerState.status}${contextLabel ? ` · ${contextLabel}` : ""}`));
				ctx.ui.setWidget(
					options.widgetKey,
					internalUi.createEvalsWidgetComponent(
						internalUi.buildEvalsWidgetModel(optimizerState, optimizerState.activeProfileId, options.optimizerLiveRun, contextLabel),
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

export function summarizeEvals(summary: string, optimizerLiveRun: LiveRunSnapshot | null): string {
	return `# Evals

${summary}

Active optimizer run:
${
		optimizerLiveRun
			? `${optimizerLiveRun.role}/${optimizerLiveRun.phase}${optimizerLiveRun.latestToolName ? ` · ${optimizerLiveRun.latestToolName}` : ""}${optimizerLiveRun.latestMessage ? ` · ${optimizerLiveRun.latestMessage.slice(0, 80)}` : ""}`
			: "idle"
	}`;
}
