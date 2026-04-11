import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { LiveRunSnapshot, QuestActiveRun, QuestFeature, QuestMilestone, QuestState, QuestStatus } from "./types.js";
import { truncate } from "./utils.js";

function statusColor(status: QuestStatus): QuestWidgetModel["statusColor"] {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "blocked":
		case "aborted":
			return "error";
		case "paused":
			return "warning";
		default:
			return "muted";
	}
}

export interface QuestWidgetModel {
	title: string;
	status: QuestStatus;
	statusColor: "accent" | "success" | "warning" | "error" | "muted";
	modeLabel: string;
	contextLabel?: string;
	focusLabel: string;
	milestoneLabel: string;
	featureLabel: string;
	validationProgress: string;
	validationStats: string;
	warnings: number;
	runLabel: string;
	summary: string;
}

export interface QuestControlItem {
	value: string;
	label: string;
	description?: string;
	detailMarkdown: string;
}

export type QuestWidgetFactory = (tui: TUI, theme: Theme) => Component;

function currentMilestone(quest: QuestState): QuestMilestone | undefined {
	return quest.plan?.milestones.find((milestone) => milestone.status !== "completed");
}

function currentMilestoneFeatures(quest: QuestState, milestoneId: string): QuestFeature[] {
	return (quest.plan?.features ?? [])
		.filter((feature) => feature.milestoneId === milestoneId)
		.sort((left, right) => left.order - right.order);
}

function nextPendingFeature(quest: QuestState, milestoneId: string): QuestFeature | undefined {
	return currentMilestoneFeatures(quest, milestoneId).find((feature) => feature.status !== "completed");
}

function assertionCounts(quest: QuestState) {
	const assertions = quest.validationState?.assertions ?? [];
	const passed = assertions.filter((assertion) => assertion.status === "passed").length;
	const failed = assertions.filter((assertion) => assertion.status === "failed").length;
	const limited = assertions.filter((assertion) => assertion.status === "limited").length;
	return {
		total: assertions.length,
		passed,
		failed,
		limited,
		pending: Math.max(0, assertions.length - passed - failed - limited),
	};
}

function readinessWarningCount(quest: QuestState): number {
	return (quest.validationReadiness?.checks ?? []).filter((check) => check.status === "limited" || check.status === "unsupported").length;
}

function questActiveRun(quest: QuestState, liveRun: LiveRunSnapshot | null): QuestActiveRun | null {
	if (liveRun) {
		return {
			role: liveRun.role,
			kind: liveRun.role === "validator" ? "validator" : liveRun.role === "worker" ? "feature" : "replan",
			featureId: liveRun.featureId,
			milestoneId: liveRun.milestoneId,
			phase: liveRun.phase,
			startedAt: liveRun.updatedAt,
		};
	}
	return quest.activeRun ?? null;
}

function progressBar(done: number, total: number, width = 12): string {
	if (total <= 0) return `[${"-".repeat(width)}]`;
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function markdownList(items: string[] | undefined, fallback = "none"): string {
	if (!items || items.length === 0) return `- ${fallback}`;
	return items.map((item) => `- ${item}`).join("\n");
}

function summaryDetailMarkdown(
	quest: QuestState,
	milestone: QuestMilestone | undefined,
	feature: QuestFeature | undefined,
	activeRun: QuestActiveRun | null,
	assertions: ReturnType<typeof assertionCounts>,
	warnings: number,
): string {
	return [
		"# Quest Summary",
		"",
		`- Status: ${quest.status}`,
		`- Goal: ${quest.goal}`,
		`- Focus: ${questFocusLabel(quest, milestone, feature)}`,
		`- Milestone: ${milestone?.title ?? "none"}`,
		`- Feature: ${feature?.title ?? "none"}`,
		`- Active run: ${activeRun ? `${activeRun.role}/${activeRun.phase}` : "idle"}`,
		`- Validation: ${assertions.passed}/${assertions.total} passed, ${assertions.failed} failed, ${assertions.limited} limited`,
		`- Readiness warnings: ${warnings}`,
		`- Human QA: ${quest.humanQaStatus}`,
		"",
		"## Latest Summary",
		quest.lastSummary ?? quest.lastError ?? "No summary yet.",
	].join("\n");
}

function milestoneDetailMarkdown(quest: QuestState, milestone: QuestMilestone): string {
	const milestoneFeatures = currentMilestoneFeatures(quest, milestone.id);
	return [
		`# Milestone: ${milestone.title}`,
		"",
		`- Status: ${milestone.status}`,
		`- Description: ${milestone.description}`,
		"",
		"## Success Criteria",
		markdownList(milestone.successCriteria, "No success criteria yet."),
		"",
		"## Features",
		markdownList(milestoneFeatures.map((feature) => `${feature.title} [${feature.status}]`), "No features yet."),
	].join("\n");
}

function featureDetailMarkdown(quest: QuestState, feature: QuestFeature): string {
	const milestone = quest.plan?.milestones.find((candidate) => candidate.id === feature.milestoneId);
	return [
		`# Feature: ${feature.title}`,
		"",
		`- Status: ${feature.status}`,
		`- Milestone: ${milestone?.title ?? feature.milestoneId}`,
		`- Description: ${feature.description}`,
		"",
		"## Preconditions",
		markdownList(feature.preconditions, "No preconditions."),
		"",
		"## Fulfills",
		markdownList(feature.fulfills, "No linked assertions."),
		"",
		"## Handoff",
		feature.handoff ?? "No handoff note.",
		"",
		"## Last Run",
		feature.lastRunSummary ?? feature.lastError ?? "No run recorded yet.",
	].join("\n");
}

function runDetailMarkdown(run: QuestState["recentRuns"][number]): string {
	return [
		`# Run: ${run.role}`,
		"",
		`- Phase: ${run.phase}`,
		`- Tool: ${run.latestToolName ?? "none"}`,
		`- Exit code: ${run.exitCode}`,
		`- Success: ${run.ok ? "yes" : "no"}`,
		"",
		"## Summary",
		run.summary,
		"",
		"## Issues",
		markdownList(run.issues, "No issues."),
		"",
		"## Stderr",
		run.stderr?.trim() || "No stderr.",
	].join("\n");
}

function questFocusLabel(quest: QuestState, milestone: QuestMilestone | undefined, feature: QuestFeature | undefined): string {
	switch (quest.status) {
		case "planning":
			return "shape the proposal from readiness, AGENTS, and loaded skills";
		case "proposal_ready":
			return "review the proposal and accept or steer it";
		case "running":
			return feature ? `execute ${feature.title}` : milestone ? `advance ${milestone.title}` : "finish the active quest";
		case "paused":
			return "resume when the next feature and validation path are clear";
		case "blocked":
			return quest.lastError ? truncate(quest.lastError, 72) : "resolve validator issues before continuing";
		case "completed":
			return "run human QA before shipping";
		case "aborted":
			return "inspect the interruption and decide whether to resume";
	}
}

export function buildQuestWidgetModel(
	quest: QuestState,
	liveRun: LiveRunSnapshot | null,
	questModeEnabled: boolean,
	contextLabel?: string | null,
): QuestWidgetModel {
	const milestone = currentMilestone(quest);
	const feature = milestone ? nextPendingFeature(quest, milestone.id) : undefined;
	const assertions = assertionCounts(quest);
	const warnings = readinessWarningCount(quest) + assertions.limited;
	const activeRun = questActiveRun(quest, liveRun);
	const runLabel = activeRun
		? `${activeRun.role}/${activeRun.phase}${liveRun?.latestToolName ? ` → ${liveRun.latestToolName}` : ""}`
		: "idle";
	
	const validationProgress = assertions.total > 0 
		? progressBar(assertions.passed, assertions.total)
		: "∅";
	const validationStats = assertions.total > 0
		? `${assertions.passed}/${assertions.total} passed`
		: "no assertions";
	
	return {
		title: truncate(quest.plan?.title ?? quest.title, 84),
		status: quest.status,
		statusColor: statusColor(quest.status),
		modeLabel: questModeEnabled ? "quest on" : "manual",
		contextLabel: contextLabel ?? undefined,
		focusLabel: questFocusLabel(quest, milestone, feature),
		milestoneLabel: milestone ? truncate(milestone.title, 44) : "∅",
		featureLabel: feature ? truncate(feature.title, 44) : "∅",
		validationProgress,
		validationStats,
		warnings,
		runLabel,
		summary: truncate(quest.lastSummary ?? quest.lastError ?? "waiting for next event", 96),
	};
}

export function buildQuestControlItems(quest: QuestState, liveRun: LiveRunSnapshot | null): QuestControlItem[] {
	const milestone = currentMilestone(quest);
	const feature = milestone ? nextPendingFeature(quest, milestone.id) : undefined;
	const assertions = assertionCounts(quest);
	const warnings = readinessWarningCount(quest) + assertions.limited;
	const activeRun = questActiveRun(quest, liveRun);
	const items: QuestControlItem[] = [
		{
			value: "summary",
			label: "Summary",
			description: `${quest.status} · ${quest.plan?.title ?? quest.title}`,
			detailMarkdown: summaryDetailMarkdown(quest, milestone, feature, activeRun, assertions, warnings),
		},
	];

	if (milestone) {
		items.push({
			value: `milestone:${milestone.id}`,
			label: milestone.title,
			description: `milestone · ${milestone.status}`,
			detailMarkdown: milestoneDetailMarkdown(quest, milestone),
		});
	}

	for (const candidate of quest.plan?.features ?? []) {
		items.push({
			value: `feature:${candidate.id}`,
			label: truncate(candidate.title, 72),
			description: `feature · ${candidate.status}`,
			detailMarkdown: featureDetailMarkdown(quest, candidate),
		});
	}

	for (const run of quest.recentRuns.slice(0, 8)) {
		items.push({
			value: `run:${run.id}`,
			label: truncate(`[${run.role}] ${run.summary}`, 72),
			description: `run · ${run.phase}${run.latestToolName ? ` · ${run.latestToolName}` : ""}`,
			detailMarkdown: runDetailMarkdown(run),
		});
	}

	return items;
}

export function renderQuestWidgetLines(model: QuestWidgetModel): string[] {
	return [
		`QUEST // ${model.title}`,
		`Status ${model.status}  |  ${model.modeLabel}${model.contextLabel ? `  |  ${model.contextLabel}` : ""}  |  Run ${model.runLabel}`,
		`Focus ${model.focusLabel}`,
		`Milestone ${model.milestoneLabel}  |  Feature ${model.featureLabel}`,
		`Validation ${model.validationProgress} ${model.validationStats}  |  ${model.warnings > 0 ? `⚠ ${model.warnings}` : "✓"}`,
		`Summary ${model.summary}`,
	];
}

export function renderQuestActionLines(status: QuestWidgetModel["status"]): string[] {
	const statusAction =
		status === "proposal_ready"
			? "/quest accept"
			: status === "running"
				? "/quest pause"
			: status === "paused" || status === "blocked"
				? "/quest resume"
				: "/quest new";
	return [`Actions ${statusAction}  |  /quest  |  /quests`];
}

export function createQuestModeWidgetComponent(contextLabel?: string | null): QuestWidgetFactory {
	const lines = [
		"QUEST // ready",
		`Status quest mode on${contextLabel ? `  |  ${contextLabel}` : ""}  |  Active none`,
		"Focus plain input now creates a quest in this repo",
	];
	const actionLines = ["Actions /quest new <goal>  |  /quests"];
	return (_tui, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.bold(theme.fg("accent", lines[0])), 1, 0));
		for (const line of lines.slice(1)) {
			container.addChild(new Text(theme.fg("text", line), 1, 0));
		}
		container.addChild(new Spacer(1));
		for (const line of actionLines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return container;
	};
}

export function createQuestWidgetComponent(model: QuestWidgetModel): QuestWidgetFactory {
	const lines = renderQuestWidgetLines(model);
	const actionLines = renderQuestActionLines(model.status);
	return (_tui, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.bold(theme.fg(model.statusColor, lines[0] ?? "QUEST")), 1, 0));
		for (const line of lines.slice(1)) {
			container.addChild(new Text(theme.fg("text", line), 1, 0));
		}
		container.addChild(new Spacer(1));
		for (const line of actionLines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return container;
	};
}
