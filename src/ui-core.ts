import type { QuestStatus, QuestTrialStatus, QuestTrialState, LiveRunSnapshot, QuestActiveRun, QuestFeature, QuestMilestone, QuestState } from "./types.js";
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

function trialsStatusColor(status: QuestTrialStatus): TrialsWidgetModel["statusColor"] {
	switch (status) {
		case "running":
			return "accent";
		case "stopped":
			return "success";
		case "blocked":
			return "error";
		case "idle":
		default:
			return "muted";
	}
}

export interface QuestWidgetModel {
	title: string;
	status: QuestStatus;
	statusColor: "accent" | "success" | "warning" | "error" | "muted";
	modeLabel: string;
	focusLabel: string;
	milestoneLabel: string;
	featureLabel: string;
	validationProgress: string;
	validationStats: string;
	warnings: number;
	runLabel: string;
	summary: string;
}

export interface TrialsWidgetModel {
	target: string;
	profileId: string;
	status: QuestTrialState["status"];
	statusColor: "accent" | "success" | "warning" | "error" | "muted";
	runLabel: string;
	runStatus: string;
	iterationLabel: string;
	summary: string;
	progress: string;
}

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

export function buildQuestWidgetModel(quest: QuestState, liveRun: LiveRunSnapshot | null, questModeEnabled: boolean): QuestWidgetModel {
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

export function renderQuestWidgetLines(model: QuestWidgetModel): string[] {
	return [
		`QUEST // ${model.title}`,
		`Status ${model.status}  |  ${model.modeLabel}  |  Run ${model.runLabel}`,
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
	return [`Actions ${statusAction}  |  /quest  |  /quests  |  /quest trials`];
}

export function buildTrialsWidgetModel(state: QuestTrialState, profileId: string, liveRun: LiveRunSnapshot | null): TrialsWidgetModel {
	const runLabel = liveRun 
		? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` → ${liveRun.latestToolName}` : ""}`
		: "idle";
	const runStatus = state.status === "running" ? "active" : state.status === "blocked" ? "blocked" : "idle";
	
	return {
		target: state.target,
		profileId,
		status: state.status,
		statusColor: trialsStatusColor(state.status),
		runLabel,
		runStatus,
		iterationLabel: state.currentCandidateId ? `cand ${state.currentCandidateId}` : "no candidate",
		summary: truncate(state.lastSummary ?? "trials idle", 96),
		progress: state.status === "running" ? "∫ running" : state.status === "blocked" ? "⊘ blocked" : "○ idle",
	};
}

export function renderTrialsWidgetLines(model: TrialsWidgetModel): string[] {
	return [
		`TRIALS // target ${model.target}`,
		`Status ${model.status}  |  Profile ${model.profileId}  |  Run ${model.runLabel}`,
		`Summary ${model.summary}`,
	];
}

export function renderTrialsActionLines(): string[] {
	return [
		"Actions /quest trials status  |  /quest trials prepare-benchmark  |  /quest trials analyze-community  |  /quest trials baseline  |  /quest trials run",
	];
}
