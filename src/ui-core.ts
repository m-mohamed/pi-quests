import type { LiveRunSnapshot, QuestActiveRun, QuestFeature, QuestMilestone, QuestState, QuestTrialState } from "./types.js";

export interface QuestWidgetModel {
	title: string;
	status: string;
	modeLabel: string;
	focusLabel: string;
	milestoneLabel: string;
	featureLabel: string;
	assertionsPassed: number;
	assertionsTotal: number;
	assertionsFailed: number;
	assertionsLimited: number;
	assertionsPending: number;
	warningCount: number;
	runLabel: string;
	summary: string;
}

export interface TrialsWidgetModel {
	target: string;
	profileId: string;
	status: string;
	runLabel: string;
	summary: string;
}

function truncate(text: string | undefined, max: number): string {
	if (!text) return "none";
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
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
		? `${activeRun.role}/${activeRun.phase}${liveRun?.latestToolName ? ` -> ${liveRun.latestToolName}` : ""}`
		: "idle";
	return {
		title: truncate(quest.plan?.title ?? quest.title, 84),
		status: quest.status,
		modeLabel: questModeEnabled ? "quest mode on" : "manual quest control",
		focusLabel: questFocusLabel(quest, milestone, feature),
		milestoneLabel: milestone ? truncate(milestone.title, 44) : "none",
		featureLabel: feature ? truncate(feature.title, 44) : "none",
		assertionsPassed: assertions.passed,
		assertionsTotal: assertions.total,
		assertionsFailed: assertions.failed,
		assertionsLimited: assertions.limited,
		assertionsPending: assertions.pending,
		warningCount: warnings,
		runLabel,
		summary: truncate(quest.lastSummary ?? quest.lastError ?? "Waiting for the next quest event.", 96),
	};
}

export function renderQuestWidgetLines(model: QuestWidgetModel): string[] {
	return [
		`QUEST // ${model.title}`,
		`Status ${model.status}  |  ${model.modeLabel}  |  Run ${model.runLabel}`,
		`Focus  ${model.focusLabel}`,
		`Milestone ${model.milestoneLabel}  |  Feature ${model.featureLabel}`,
		`Validation ${progressBar(model.assertionsPassed, model.assertionsTotal)} ${model.assertionsPassed}/${model.assertionsTotal} passed  |  warnings ${model.warningCount}`,
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
	return {
		target: state.target,
		profileId,
		status: state.status,
		runLabel: liveRun ? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` -> ${liveRun.latestToolName}` : ""}` : "idle",
		summary: truncate(state.lastSummary ?? "Trial loop idle.", 96),
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
	return ["Actions /quest trials  |  /quest trials run  |  /quest trials stop  |  /quest trials profile"];
}
