import { type ContextUsage, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatContextUsageLabel } from "./extension-core.js";
import {
	buildQuestWidgetModel,
	createQuestModeWidgetComponent,
	createQuestWidgetComponent,
} from "./ui-core.js";
import type { LiveRunSnapshot, QuestState } from "./types.js";

export function applyTransientUiState(
	ctx: ExtensionContext,
	quest: QuestState | null,
	state: {
		liveRun: LiveRunSnapshot | null;
	},
) {
	if (!ctx.hasUI) return;
	if (quest && state.liveRun) {
		const working = `Quest ${state.liveRun.role} · ${state.liveRun.phase}${state.liveRun.latestToolName ? ` · ${state.liveRun.latestToolName}` : ""}`;
		ctx.ui.setWorkingMessage(working);
		ctx.ui.setHiddenThinkingLabel(`quest:${state.liveRun.role}`);
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
		liveRun: LiveRunSnapshot | null;
	},
) {
	if (!ctx.hasUI) return;
	const contextLabel = formatContextUsageLabel(options.lastContextUsage);
	applyTransientUiState(ctx, quest, {
		liveRun: options.liveRun,
	});
	if (!quest) {
		if (options.questModeEnabled) {
			ctx.ui.setStatus(options.statusKey, ctx.ui.theme.fg("accent", `quest:mode${contextLabel ? ` · ${contextLabel}` : ""}`));
			ctx.ui.setWidget(options.widgetKey, createQuestModeWidgetComponent(contextLabel));
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
