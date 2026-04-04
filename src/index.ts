import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, Text, matchesKey } from "@mariozechner/pi-tui";
import { applyQuestProfilePatch, defaultQuestProfile, summarizeExperimentScores, traceBundleFromPlanningSession, traceBundleFromWorkerRun } from "./trials-core.js";
import { loadQuestTrialsSnapshot, replayQuestRunIntoTrialDataset, runQuestTrialsLoop } from "./trials-runtime.js";
import { defaultHumanQaChecklist, mergeRemainingPlan, parseQuestPlanText, planningInstructions, synthesizeValidationAssertions } from "./plan-core.js";
import { describeActiveRun, markQuestAborted, prepareQuestForResume, terminateQuestProcess } from "./runtime-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import {
	buildQuestWidgetModel,
	buildTrialsWidgetModel,
	renderQuestActionLines,
	renderQuestWidgetLines,
	renderTrialsActionLines,
	renderTrialsWidgetLines,
} from "./ui-core.js";
import {
	appendQuestEvent,
	createQuest,
	getQuestPaths,
	listProjectQuests,
	loadActiveQuest,
	loadQuestExperiment,
	loadQuestTrialState,
	loadLearnedWorkflows,
	loadQuestProfile,
	loadQuest,
	pruneQuestStorage,
	projectIdFor,
	saveQuestEvalDataset,
	saveQuestExperiment,
	saveQuestTrialState,
	saveQuestProfile,
	saveLearnedWorkflows,
	saveQuest,
	switchActiveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
} from "./state.js";
import { executeFeatureWorker, executePlanRevision, executeValidationReadinessProbe, executeValidator } from "./workers.js";
import { deriveLearnedWorkflows, mergeLearnedWorkflows } from "./workflows.js";
import type {
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
	QuestExperiment,
	QuestFeature,
	QuestTrialState,
	QuestMilestone,
	QuestProfile,
	QuestRole,
	QuestState,
	QuestActiveRun,
	ThinkingLevel,
	ValidationAssertion,
	ValidationReadiness,
	ValidationSurfaceStatus,
	WorkerEventRecord,
} from "./types.js";

const CUSTOM_MESSAGE_TYPE = "pi-quests";
const STATUS_KEY = "pi-quests";
const WIDGET_KEY = "pi-quests";
const WIDGET_ACTIONS_KEY = "pi-quests-actions";
const QUEST_MODE_ENTRY = "quest-mode";
const QUEST_DASHBOARD_ENTRY = "quest-control";
const ROLE_NAMES: QuestRole[] = ["orchestrator", "worker", "validator"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DASHBOARD_TABS = ["summary", "features", "runs", "detail"] as const;
type DashboardTab = (typeof DASHBOARD_TABS)[number];

const questExperimentScoreSchema = Type.Object({
	datasetId: Type.String(),
	caseIds: Type.Array(Type.String()),
	passed: Type.Number(),
	failed: Type.Number(),
	score: Type.Number(),
	maxScore: Type.Number(),
	findings: Type.Array(Type.String()),
});

const questPromptSurfacesPatchSchema = Type.Object({
	planningPolicy: Type.Optional(Type.String()),
	workerPolicy: Type.Optional(Type.String()),
	validatorCodeReviewPolicy: Type.Optional(Type.String()),
	validatorUserSurfacePolicy: Type.Optional(Type.String()),
	readinessPolicy: Type.Optional(Type.String()),
	revisionPolicy: Type.Optional(Type.String()),
});

const questModelPolicyPatchSchema = Type.Object({
	preferSameModelFamily: Type.Optional(Type.Boolean()),
	preferValidatorDivergence: Type.Optional(Type.Boolean()),
});

const questVerificationBudgetPatchSchema = Type.Object({
	workerAttempts: Type.Optional(Type.Number()),
	validatorAttempts: Type.Optional(Type.Number()),
	correctiveFeatureBudget: Type.Optional(Type.Number()),
});

const questContextPolicyPatchSchema = Type.Object({
	spillThresholdChars: Type.Optional(Type.Number()),
	spillLongOutputsToReports: Type.Optional(Type.Boolean()),
	maxInlineEvidenceLines: Type.Optional(Type.Number()),
});

const questWorkflowHintPolicyPatchSchema = Type.Object({
	maxSharedHints: Type.Optional(Type.Number()),
	promotePrerequisiteHints: Type.Optional(Type.Boolean()),
	promoteFailureHints: Type.Optional(Type.Boolean()),
});

const questTraceGradingPatchSchema = Type.Object({
	toolHeavyCount: Type.Optional(Type.Number()),
	longRunMs: Type.Optional(Type.Number()),
	repeatedCorrectiveThreshold: Type.Optional(Type.Number()),
	weakValidationPenalty: Type.Optional(Type.Number()),
	blockedPenalty: Type.Optional(Type.Number()),
	overflowPenalty: Type.Optional(Type.Number()),
	abortPenalty: Type.Optional(Type.Number()),
});

function createDefaultModelChoice(model: Model<any> | null, thinkingLevel: ThinkingLevel): ModelChoice {
	return {
		provider: model?.provider ?? "openai-codex",
		model: model?.id ?? "gpt-5.4",
		thinkingLevel,
	};
}

function truncate(text: string, max = 120): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}

function modelLabel(choice: ModelChoice | undefined): string {
	if (!choice) return "inherit";
	return `${choice.provider}/${choice.model}:${choice.thinkingLevel}`;
}

function roleFromArg(arg: string): QuestRole | null {
	const normalized = arg.trim().toLowerCase();
	return ROLE_NAMES.includes(normalized as QuestRole) ? (normalized as QuestRole) : null;
}

function currentOrDefaultModel(quest: QuestState, role: QuestRole): ModelChoice {
	return quest.roleModels[role] ?? quest.defaultModel;
}

function activeProfileFor(cwd: string, profile: QuestProfile | null, target: QuestTrialState["target"] = "repo"): QuestProfile {
	return profile ?? defaultQuestProfile(projectIdFor(cwd), target);
}

function syncQuestConfig(quest: QuestState) {
	quest.config.orchestratorModel = currentOrDefaultModel(quest, "orchestrator");
	quest.config.workerModel = currentOrDefaultModel(quest, "worker");
	quest.config.validatorModel = currentOrDefaultModel(quest, "validator");
}

function currentMilestone(quest: QuestState): QuestMilestone | undefined {
	if (!quest.plan) return undefined;
	return quest.plan.milestones
		.slice()
		.sort((a, b) => a.order - b.order)
		.find((milestone) => milestone.status !== "completed");
}

function currentMilestoneFeatures(quest: QuestState, milestoneId: string): QuestFeature[] {
	return (quest.plan?.features ?? [])
		.filter((feature) => feature.milestoneId === milestoneId)
		.sort((a, b) => a.order - b.order);
}

function nextPendingFeature(quest: QuestState, milestoneId: string): QuestFeature | undefined {
	return currentMilestoneFeatures(quest, milestoneId).find((feature) => feature.status === "pending");
}

function assertionCounts(quest: QuestState) {
	const assertions = quest.validationState?.assertions ?? [];
	return {
		total: assertions.length,
		passed: assertions.filter((assertion) => assertion.status === "passed").length,
		failed: assertions.filter((assertion) => assertion.status === "failed").length,
		limited: assertions.filter((assertion) => assertion.status === "limited").length,
		pending: assertions.filter((assertion) => assertion.status === "pending").length,
	};
}

function readinessWarningCount(quest: QuestState) {
	return (quest.validationReadiness?.checks ?? []).filter((check) => check.status === "limited" || check.status === "unsupported").length;
}

function humanQaChecklist(quest: QuestState): string[] {
	return defaultHumanQaChecklist(
		quest.plan ?? {
			title: quest.title,
			summary: quest.goal,
			risks: [],
			environment: [],
			services: [],
			humanQaChecklist: ["Review the primary user flows manually before shipping."],
			milestones: [],
			features: [],
		},
	);
}

function questActiveRun(quest: QuestState, liveRun: LiveRunSnapshot | null): QuestActiveRun | null {
	if (liveRun) {
		return {
			role: liveRun.role,
			kind: liveRun.role === "validator" ? "validator" : liveRun.role === "orchestrator" ? "replan" : "feature",
			featureId: liveRun.featureId,
			milestoneId: liveRun.milestoneId,
			phase: liveRun.phase,
			startedAt: quest.activeRun?.startedAt ?? Date.now(),
			pid: quest.activeRun?.pid,
			abortRequestedAt: quest.activeRun?.abortRequestedAt,
		};
	}
	return quest.activeRun ?? null;
}

function summarizeRecentRuns(quest: QuestState): string {
	if (quest.recentRuns.length === 0) return "none";
	return quest.recentRuns
		.slice(0, 4)
		.map((run) => `[${run.role}] ${run.summary}${run.latestToolName ? ` · ${run.latestToolName}` : ""}`)
		.join("\n");
}

function summarizeQuest(quest: QuestState, workflows: LearnedWorkflow[], liveRun: LiveRunSnapshot | null, questModeEnabled: boolean): string {
	const featureCount = quest.plan?.features.length ?? 0;
	const done = quest.plan?.features.filter((feature) => feature.status === "completed").length ?? 0;
	const milestone = currentMilestone(quest);
	const readinessWarnings = readinessWarningCount(quest);
	const assertions = assertionCounts(quest);
	const activeRun = questActiveRun(quest, liveRun);
	const readinessLines =
		quest.validationReadiness?.checks.length
			? quest.validationReadiness.checks.map((check) => `- ${check.surface}: ${check.status}${check.notes ? ` · ${check.notes}` : ""}`).join("\n")
			: "- none";

	return `# Quest: ${quest.plan?.title ?? quest.title}

- Status: ${quest.status}
- Quest mode: ${questModeEnabled ? "on" : "off"}
- Goal: ${quest.goal}
- Default model: ${modelLabel(quest.defaultModel)}
- Orchestrator model: ${modelLabel(currentOrDefaultModel(quest, "orchestrator"))}
- Worker model: ${modelLabel(currentOrDefaultModel(quest, "worker"))}
- Validator model: ${modelLabel(currentOrDefaultModel(quest, "validator"))}
- Features: ${done}/${featureCount} complete
- Active milestone: ${milestone ? `${milestone.title} [${milestone.status}]` : "none"}
- Validation assertions: ${assertions.passed}/${assertions.total} passed · ${assertions.failed} failed · ${assertions.limited} limited · ${assertions.pending} pending
- Validation readiness warnings: ${readinessWarnings}
- Learned workflows: ${workflows.length}
- Active run: ${
		liveRun
			? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` · ${liveRun.latestToolName}` : ""}${liveRun.latestMessage ? ` · ${truncate(liveRun.latestMessage, 80)}` : ""}`
			: activeRun
				? `${describeActiveRun(quest, activeRun)} · ${activeRun.phase}`
				: "idle"
	}
${quest.lastSummary ? `- Last summary: ${quest.lastSummary}` : ""}
${quest.lastError ? `- Last error: ${quest.lastError}` : ""}

Validation readiness:
${readinessLines}

Recent runs:
${summarizeRecentRuns(quest)}

Human QA checklist:
${humanQaChecklist(quest).map((item) => `- ${item}`).join("\n")}
`;
}

async function emitNote(pi: ExtensionAPI, ctx: ExtensionContext, content: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(content, level);
	pi.sendMessage({ customType: CUSTOM_MESSAGE_TYPE, content, display: true }, { triggerTurn: false });
}

function parseModelChoiceSpec(spec: string, fallback: ModelChoice): ModelChoice | null {
	const trimmed = spec.trim();
	if (!trimmed) return null;
	const [providerModel, thinking] = trimmed.split(":");
	const slashIndex = providerModel.indexOf("/");
	if (slashIndex <= 0 || slashIndex === providerModel.length - 1) return null;
	const provider = providerModel.slice(0, slashIndex);
	const model = providerModel.slice(slashIndex + 1);
	const thinkingLevel = thinking && THINKING_LEVELS.includes(thinking as ThinkingLevel) ? (thinking as ThinkingLevel) : fallback.thinkingLevel;
	return { provider, model, thinkingLevel };
}

function readinessSummaryForWarnings(quest: QuestState): string {
	const weak = (quest.validationReadiness?.checks ?? []).filter((check) => check.status === "limited" || check.status === "unsupported");
	if (weak.length === 0) return "All captured validation surfaces are supported.";
	return weak.map((check) => `${check.surface}:${check.status}`).join(", ");
}

function relevantAssertionsForPass(quest: QuestState, milestoneId: string, pass: "code_review" | "user_surface"): ValidationAssertion[] {
	const assertions = (quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestoneId);
	return pass === "code_review"
		? assertions.filter((assertion) => assertion.method !== "user_surface")
		: assertions.filter((assertion) => assertion.method === "user_surface" || assertion.method === "mixed");
}

function markAssertions(
	quest: QuestState,
	assertions: ValidationAssertion[],
	status: ValidationAssertion["status"],
	evidenceLine: string,
) {
	if (!quest.validationState) return;
	const ids = new Set(assertions.map((assertion) => assertion.id));
	quest.validationState.assertions = quest.validationState.assertions.map((assertion) => {
		if (!ids.has(assertion.id)) return assertion;
		return {
			...assertion,
			status,
			evidence: evidenceLine ? [...assertion.evidence, evidenceLine].slice(-8) : assertion.evidence,
		};
	});
	quest.validationState.updatedAt = Date.now();
}

function mergeValidationAssertions(existing: ValidationAssertion[], next: ValidationAssertion[]): ValidationAssertion[] {
	const byId = new Map(existing.map((assertion) => [assertion.id, assertion]));
	return next.map((assertion) => {
		const previous = byId.get(assertion.id);
		return previous
			? {
					...assertion,
					status: previous.status,
					evidence: previous.evidence,
				}
			: assertion;
	});
}

function appendCorrectiveFeatures(quest: QuestState, milestone: QuestMilestone, issues: string[], assertions: ValidationAssertion[]) {
	if (!quest.plan) return;
	const maxOrder = Math.max(0, ...quest.plan.features.map((feature) => feature.order));
	const targetAssertionIds = assertions.map((assertion) => assertion.id);
	const corrective = issues.map((issue, index) => ({
		id: `fix-${randomUUID()}`,
		order: maxOrder + index + 1,
		milestoneId: milestone.id,
		title: `Corrective follow-up ${index + 1}`,
		description: issue,
		preconditions: [],
		fulfills: targetAssertionIds,
		status: "pending" as const,
		handoff: `Resolve validator issue: ${issue}`,
	}));
	quest.plan.features.push(...corrective);
}

function synthesizeAssertionsForQuestPlan(quest: QuestState) {
	if (!quest.plan) return;
	const next = synthesizeValidationAssertions(quest.plan.milestones, quest.plan.features);
	quest.validationState = {
		assertions: mergeValidationAssertions(quest.validationState?.assertions ?? [], next),
		updatedAt: Date.now(),
	};
}

function proposalReady(quest: QuestState): boolean {
	return Boolean(quest.plan && quest.validationReadiness && quest.validationState && quest.plan.features.length > 0);
}

export default function questExtension(pi: ExtensionAPI) {
	let currentQuest: QuestState | null = null;
	let currentWorkflows: LearnedWorkflow[] = [];
	let currentProfile: QuestProfile | null = null;
	let currentTrialState: QuestTrialState | null = null;
	let liveRun: LiveRunSnapshot | null = null;
	let trialLiveRun: LiveRunSnapshot | null = null;
	let planningEvents: WorkerEventRecord[] = [];
	let planningStartedAt = 0;
	let questModeEnabled = false;
	let planningTurnActive = false;
	let dashboardTab: DashboardTab = "summary";
	let activeTrialPid: number | undefined;
	let pendingQuestControlOpen = false;

	function persistQuestMode() {
		pi.appendEntry(QUEST_MODE_ENTRY, { enabled: questModeEnabled });
	}

	function persistDashboardTab() {
		pi.appendEntry(QUEST_DASHBOARD_ENTRY, { tab: dashboardTab });
	}

	async function applyQuestUi(ctx: ExtensionContext, quest: QuestState | null) {
		if (!ctx.hasUI) return;
		if (!quest) {
			if (questModeEnabled) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "quest:mode"));
				ctx.ui.setWidget(WIDGET_KEY, [
					"QUEST // ready",
					"Status quest mode on  |  Active none",
					"Focus plain input now creates a quest in this repo",
				]);
				ctx.ui.setWidget(WIDGET_ACTIONS_KEY, ["Actions /quest new <goal>  |  /quests  |  /quest trials"]);
			} else if (currentTrialState?.status === "running") {
				const trialState = currentTrialState;
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `trials:${trialState.status}`));
				ctx.ui.setWidget(WIDGET_KEY, renderTrialsWidgetLines(buildTrialsWidgetModel(trialState, trialState.activeProfileId, trialLiveRun)));
				ctx.ui.setWidget(WIDGET_ACTIONS_KEY, renderTrialsActionLines());
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setWidget(WIDGET_ACTIONS_KEY, undefined);
			}
			return;
		}
		const liveSummary = liveRun ? ` · ${liveRun.role}:${liveRun.phase}` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `quest:${quest.status}${liveSummary}`));
		ctx.ui.setWidget(WIDGET_KEY, renderQuestWidgetLines(buildQuestWidgetModel(quest, liveRun, questModeEnabled)));
		ctx.ui.setWidget(WIDGET_ACTIONS_KEY, renderQuestActionLines(quest.status));
	}

	async function refreshCurrentQuest(cwd: string) {
		if (!currentQuest) return null;
		currentQuest = await loadQuest(cwd, currentQuest.id);
		return currentQuest;
	}

	async function persistActiveRun(ctx: ExtensionContext, quest: QuestState, activeRun: QuestActiveRun | null) {
		quest.activeRun = activeRun ?? undefined;
		await saveQuest(quest);
		await applyQuestUi(ctx, quest);
	}

	async function persistLearnedWorkflows(run: QuestState["recentRuns"][number]) {
		const additions = deriveLearnedWorkflows(run);
		if (additions.length === 0 || !currentQuest) return;
		currentWorkflows = mergeLearnedWorkflows(currentWorkflows, additions);
		await saveLearnedWorkflows(currentQuest.cwd, currentWorkflows);
	}

	async function loadQuestForContext(ctx: ExtensionContext) {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		currentTrialState = await loadQuestTrialState(ctx.cwd);
		currentProfile = await loadQuestProfile(ctx.cwd, currentTrialState.activeProfileId, { target: currentTrialState.target });
		if (!currentQuest || currentQuest.status !== "planning") {
			liveRun = null;
			planningEvents = [];
		}
		await applyQuestUi(ctx, currentQuest);
	}

	async function setQuestMode(ctx: ExtensionContext, enabled: boolean) {
		questModeEnabled = enabled;
		if (!enabled) planningTurnActive = false;
		persistQuestMode();
		await applyQuestUi(ctx, currentQuest);
	}

	async function ensureCurrentQuest(ctx: ExtensionContext): Promise<QuestState | null> {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		currentTrialState = await loadQuestTrialState(ctx.cwd);
		currentProfile = await loadQuestProfile(ctx.cwd, currentTrialState.activeProfileId, { target: currentTrialState.target });
		if (!currentQuest) {
			await emitNote(pi, ctx, "No active quest in this repo. Use `/quest new <goal>` first.", "warning");
			return null;
		}
		return currentQuest;
	}

	async function createPlanningQuest(ctx: ExtensionContext, goal: string): Promise<QuestState> {
		const modelChoice = createDefaultModelChoice(ctx.model ?? null, pi.getThinkingLevel() as ThinkingLevel);
		currentQuest = await createQuest(ctx.cwd, goal, modelChoice);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		currentTrialState = await loadQuestTrialState(ctx.cwd, { ensure: true });
		currentProfile = await loadQuestProfile(ctx.cwd, currentTrialState.activeProfileId, { ensure: true, target: currentTrialState.target });
		await saveQuestProfile(ctx.cwd, currentProfile);
		await pruneQuestStorage(ctx.cwd);
		await setQuestMode(ctx, true);
		await emitNote(pi, ctx, `Quest created: ${goal}`);

		liveRun = createLiveRunSnapshot("validator", {}, "readiness");
		await persistActiveRun(ctx, currentQuest, {
			role: "validator",
			kind: "readiness",
			phase: "readiness",
			startedAt: Date.now(),
		});

		const probe = await executeValidationReadinessProbe(
			ctx.cwd,
			currentOrDefaultModel(currentQuest, "validator"),
			currentProfile,
			undefined,
			async (snapshot) => {
				liveRun = snapshot;
				if (currentQuest?.activeRun && currentQuest.activeRun.phase !== snapshot.phase) {
					currentQuest.activeRun.phase = snapshot.phase;
					await saveQuest(currentQuest);
				}
				await applyQuestUi(ctx, currentQuest);
			},
			async (pid) => {
				if (currentQuest?.activeRun) {
					currentQuest.activeRun.pid = pid;
					await saveQuest(currentQuest);
				}
			},
		);
		liveRun = null;
		currentQuest.recentRuns = trimRecentRuns([probe.run, ...currentQuest.recentRuns]);
		currentQuest.activeRun = undefined;
		if (probe.readiness) currentQuest.validationReadiness = probe.readiness;
		if (probe.servicesYaml) currentQuest.servicesYaml = probe.servicesYaml;
		currentQuest.lastSummary = probe.readiness
			? `Dry-run validation readiness captured. ${readinessSummaryForWarnings(currentQuest)}`
			: "Dry-run validation readiness probe could not capture structured results.";
		await saveQuest(currentQuest);
		await writeWorkerRun(currentQuest.cwd, currentQuest.id, probe.run);
		await writeQuestTraceBundle(currentQuest.cwd, traceBundleFromWorkerRun(currentQuest, probe.run, currentProfile));
		await applyQuestUi(ctx, currentQuest);
		return currentQuest;
	}

	async function openQuestControl(ctx: ExtensionContext, quest: QuestState) {
		if (!ctx.hasUI) {
			await emitNote(pi, ctx, summarizeQuest(quest, currentWorkflows, liveRun, questModeEnabled));
			return;
		}
		if (!ctx.ui.custom) {
			await emitNote(pi, ctx, summarizeQuest(quest, currentWorkflows, liveRun, questModeEnabled));
			return;
		}

		let selectedFeature = 0;
		let selectedRun = 0;

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let closed = false;
			const interval = setInterval(() => {
				void (async () => {
					currentQuest = await loadActiveQuest(ctx.cwd);
					currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
					if (!currentQuest) return;
					tui.requestRender();
				})();
			}, 1000);

			const cleanup = () => {
				if (closed) return;
				closed = true;
				clearInterval(interval);
				persistDashboardTab();
				done(undefined);
			};

			const component = {
				render(width: number) {
					const questForRender = currentQuest ?? quest;
					const milestone = currentMilestone(questForRender);
					const milestoneFeatures = milestone ? currentMilestoneFeatures(questForRender, milestone.id) : [];
					const runs = questForRender.recentRuns.slice(0, 8);
					const assertions = assertionCounts(questForRender);
					const activeFeature = milestoneFeatures[selectedFeature] ?? milestoneFeatures[0];
					const activeRun = runs[selectedRun] ?? runs[0];
					const detailLines =
						dashboardTab === "features" && activeFeature
							? [
									`Feature: ${activeFeature.title}`,
									`Status: ${activeFeature.status}`,
									`Description: ${activeFeature.description}`,
									`Fulfills: ${activeFeature.fulfills.join(", ") || "none"}`,
									`Handoff: ${activeFeature.handoff || "none"}`,
								]
							: activeRun
								? [
										`Run: ${activeRun.role}`,
										`Summary: ${activeRun.summary}`,
										`Phase: ${activeRun.phase}`,
										`Tool: ${activeRun.latestToolName || "none"}`,
										`Issues: ${activeRun.issues?.join("; ") || "none"}`,
									]
								: ["No detail selected."];
					const lines = [
						theme.bold(theme.fg("accent", `Quest Control · ${questForRender.plan?.title ?? questForRender.title}`)),
						theme.fg("muted", `tab:${dashboardTab} · q close · tab switch · j/k move · r run/resume · p pause · a abort`),
						"",
						theme.bold("Summary"),
						`status: ${questForRender.status}`,
						`milestone: ${milestone ? `${milestone.title} [${milestone.status}]` : "none"}`,
						`models: o=${modelLabel(currentOrDefaultModel(questForRender, "orchestrator"))} | w=${modelLabel(currentOrDefaultModel(questForRender, "worker"))} | v=${modelLabel(currentOrDefaultModel(questForRender, "validator"))}`,
						`validation: ${assertions.passed}/${assertions.total} passed, ${assertions.failed} failed, ${assertions.limited} limited, ${readinessWarningCount(questForRender)} readiness warnings`,
						"",
						theme.bold("Features"),
						...(milestoneFeatures.length > 0
							? milestoneFeatures.map((feature, index) =>
									`${dashboardTab === "features" && index === selectedFeature ? ">" : " "} [${feature.status}] ${feature.title}`,
								)
							: ["  none"]),
						"",
						theme.bold("Workers / Validators"),
						...(runs.length > 0
							? runs.map((run, index) =>
									`${dashboardTab === "runs" && index === selectedRun ? ">" : " "} [${run.role}] ${truncate(run.summary, Math.max(20, width - 18))}`,
								)
							: ["  none"]),
						"",
						theme.bold("Detail"),
						...detailLines,
					];
					return new Text(lines.join("\n"), 0, 0).render(width);
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || data === "q") {
						cleanup();
						return true;
					}
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						const nextIndex = (DASHBOARD_TABS.indexOf(dashboardTab) + 1) % DASHBOARD_TABS.length;
						dashboardTab = DASHBOARD_TABS[nextIndex];
						tui.requestRender();
						return true;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						const nextIndex = (DASHBOARD_TABS.indexOf(dashboardTab) - 1 + DASHBOARD_TABS.length) % DASHBOARD_TABS.length;
						dashboardTab = DASHBOARD_TABS[nextIndex];
						tui.requestRender();
						return true;
					}
					const questForInput = currentQuest ?? quest;
					const milestone = currentMilestone(questForInput);
					const milestoneFeatures = milestone ? currentMilestoneFeatures(questForInput, milestone.id) : [];
					const runs = questForInput.recentRuns.slice(0, 8);
					if ((data === "j" || matchesKey(data, Key.down)) && dashboardTab === "features") {
						selectedFeature = Math.min(milestoneFeatures.length - 1, selectedFeature + 1);
						tui.requestRender();
						return true;
					}
					if ((data === "k" || matchesKey(data, Key.up)) && dashboardTab === "features") {
						selectedFeature = Math.max(0, selectedFeature - 1);
						tui.requestRender();
						return true;
					}
					if (data === "j" && dashboardTab === "runs") {
						selectedRun = Math.min(runs.length - 1, selectedRun + 1);
						tui.requestRender();
						return true;
					}
					if (data === "k" && dashboardTab === "runs") {
						selectedRun = Math.max(0, selectedRun - 1);
						tui.requestRender();
						return true;
					}
					if (data === "r") {
						void handleQuestCommand(
							questForInput.status === "proposal_ready" ? "accept" : questForInput.status === "paused" || questForInput.status === "blocked" ? "resume" : "",
							ctx,
						).then(() => tui.requestRender());
						return true;
					}
					if (data === "p") {
						void handleQuestCommand("pause", ctx).then(() => tui.requestRender());
						return true;
					}
					if (data === "a" || data === "i") {
						void handleQuestCommand("abort", ctx).then(() => tui.requestRender());
						return true;
					}
					return false;
				},
			};
			return component;
		});
	}

	async function showQuestList(ctx: ExtensionContext) {
		const quests = await listProjectQuests(ctx.cwd);
		currentQuest = await loadActiveQuest(ctx.cwd);
		const activeQuestId = currentQuest?.id ?? null;
		if (quests.length === 0) {
			await emitNote(pi, ctx, "No quests found for this repo. Use `/quest new <goal>` to create one.");
			await applyQuestUi(ctx, currentQuest);
			return;
		}
		if (!ctx.hasUI) {
			await emitNote(
				pi,
				ctx,
				`Project quests:\n${quests.map((quest) => `- ${quest.id === activeQuestId ? "*" : " "} ${quest.title} · ${quest.status}`).join("\n")}`,
			);
			return;
		}
		const labels = quests.map((quest) => `${quest.id === activeQuestId ? "* " : ""}${quest.title} · ${quest.status} · ${quest.id}`);
		const selected = await ctx.ui.select("Project quests", labels);
		if (!selected) return;
		const selectedQuest = quests[labels.indexOf(selected)];
		if (!selectedQuest) return;
		currentQuest = await switchActiveQuest(ctx.cwd, selectedQuest.id);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		await applyQuestUi(ctx, currentQuest);
		await emitNote(pi, ctx, `Active quest set to "${selectedQuest.title}".`);
	}

	function summarizeTrials(snapshot: Awaited<ReturnType<typeof loadQuestTrialsSnapshot>>): string {
		const latestExperiment = snapshot.experiments[0];
		const latestScores = latestExperiment ? summarizeExperimentScores(latestExperiment.candidateScores) : "No experiments yet.";
		return `# Trials

- Status: ${snapshot.state.status}
- Target: ${snapshot.state.target}
- Active profile: ${snapshot.profile.id}
- Adopted changes: ${snapshot.profile.adoptedChanges.length}
- Trace bundles: ${snapshot.traces.length}
- Datasets: ${snapshot.datasets.length}
- Experiments: ${snapshot.experiments.length}
- Active trial run: ${
		trialLiveRun
			? `${trialLiveRun.phase}${trialLiveRun.latestToolName ? ` · ${trialLiveRun.latestToolName}` : ""}${trialLiveRun.latestMessage ? ` · ${truncate(trialLiveRun.latestMessage, 80)}` : ""}`
			: "idle"
	}
${snapshot.state.lastSummary ? `- Last summary: ${snapshot.state.lastSummary}` : ""}

Latest experiment:
${latestExperiment ? `- ${latestExperiment.summary}` : "- none"}
- Scores: ${latestScores}

Recent trace tags:
${snapshot.traces.slice(0, 6).map((trace) => `- [${trace.role}] ${trace.tags.join(", ") || "none"} · ${trace.summary}`).join("\n") || "- none"}
`;
	}

	async function openQuestTrialsControl(ctx: ExtensionContext) {
		const snapshot = await loadQuestTrialsSnapshot(ctx.cwd, true);
		currentTrialState = snapshot.state;
		currentProfile = snapshot.profile;
		if (!ctx.hasUI || !ctx.ui.custom) {
			await emitNote(pi, ctx, summarizeTrials(snapshot));
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let closed = false;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				done(undefined);
			};

			const component = {
				render(width: number) {
					const lines = summarizeTrials(snapshot)
						.split("\n")
						.map((line, index) => (index === 0 ? theme.bold(theme.fg("accent", line.replace(/^# /, ""))) : line));
					lines.splice(1, 0, theme.fg("muted", "q close · r run · s stop · p profile"));
					return new Text(lines.join("\n"), 0, 0).render(width);
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || data === "q") {
						cleanup();
						return true;
					}
					if (data === "r") {
						void handleQuestTrialsCommand("run", ctx).then(() => tui.requestRender());
						return true;
					}
					if (data === "s") {
						void handleQuestTrialsCommand("stop", ctx).then(() => tui.requestRender());
						return true;
					}
					if (data === "p") {
						void handleQuestTrialsCommand("profile", ctx).then(() => tui.requestRender());
						return true;
					}
					return false;
				},
			};
			return component;
		});
	}

	async function handleQuestTrialsCommand(args: string, ctx: ExtensionContext) {
		const trimmed = args.trim();
		const snapshot = await loadQuestTrialsSnapshot(ctx.cwd, true);
		currentTrialState = snapshot.state;
		currentProfile = snapshot.profile;

		if (!trimmed) {
			await openQuestTrialsControl(ctx);
			return;
		}

		const [subcommand, ...rest] = trimmed.split(/\s+/);
		const remainder = rest.join(" ").trim();

		switch (subcommand) {
			case "run": {
				if (currentTrialState.status === "running") {
					await emitNote(pi, ctx, "Trials are already running.", "warning");
					return;
				}
				const modelChoice =
					currentQuest && currentQuest.status !== "completed" && currentQuest.status !== "aborted"
						? currentOrDefaultModel(currentQuest, "orchestrator")
						: createDefaultModelChoice(ctx.model ?? null, pi.getThinkingLevel() as ThinkingLevel);
				const result = await runQuestTrialsLoop(
					ctx.cwd,
					modelChoice,
					async (snapshotUpdate) => {
						trialLiveRun = snapshotUpdate;
						await applyQuestUi(ctx, currentQuest);
					},
					async (pid) => {
						activeTrialPid = pid;
					},
				);
				activeTrialPid = undefined;
				trialLiveRun = null;
				currentTrialState = result.snapshot.state;
				currentProfile = result.snapshot.profile;
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, result.summary);
				return;
			}

			case "stop": {
				if (typeof activeTrialPid === "number") {
					await terminateQuestProcess(activeTrialPid);
				}
				activeTrialPid = undefined;
				trialLiveRun = null;
				currentTrialState.status = "stopped";
				currentTrialState.activeExperimentId = undefined;
				currentTrialState.lastSummary = "Trials stopped by operator.";
				await saveQuestTrialState(ctx.cwd, currentTrialState);
				await emitNote(pi, ctx, "Trials stopped.", "warning");
				return;
			}

			case "replay": {
				if (!remainder) {
					await emitNote(pi, ctx, "Usage: /quest trials replay <run-id>", "warning");
					return;
				}
				const dataset = await replayQuestRunIntoTrialDataset(ctx.cwd, remainder);
				if (!dataset) {
					await emitNote(pi, ctx, `No Quest trace matched run id "${remainder}".`, "warning");
					return;
				}
				await emitNote(pi, ctx, `Added replay cases to ${dataset.id}.`);
				return;
			}

			case "target": {
				if (remainder !== "repo" && remainder !== "quest-core") {
					await emitNote(pi, ctx, "Usage: /quest trials target <repo|quest-core>", "warning");
					return;
				}
				if (remainder === "quest-core" && !ctx.cwd.endsWith("/pi-quests")) {
					await emitNote(pi, ctx, "quest-core target is only available inside the pi-quests package repo.", "warning");
					return;
				}
				currentTrialState.target = remainder;
				currentTrialState.activeProfileId = `${remainder}-${currentTrialState.projectId}`;
				await saveQuestTrialState(ctx.cwd, currentTrialState);
				currentProfile = await loadQuestProfile(ctx.cwd, currentTrialState.activeProfileId, { ensure: true, target: remainder });
				await saveQuestProfile(ctx.cwd, currentProfile);
				await emitNote(pi, ctx, `Trials target set to ${remainder}.`);
				return;
			}

			case "profile": {
				const latestExperiment = snapshot.experiments[0];
				await emitNote(
					pi,
					ctx,
					`Trials profile ${snapshot.profile.id}\n- target: ${snapshot.profile.target}\n- adopted changes: ${snapshot.profile.adoptedChanges.length}\n- same-model bias: ${snapshot.profile.modelPolicy.preferSameModelFamily}\n- spill-to-reports: ${snapshot.profile.contextPolicy.spillLongOutputsToReports}\n- latest scores: ${latestExperiment ? summarizeExperimentScores(latestExperiment.candidateScores) : "none"}`,
				);
				return;
			}

			default: {
				await emitNote(
					pi,
					ctx,
					"Unknown /quest trials subcommand. Use /quest trials, /quest trials run, /quest trials stop, /quest trials replay <run-id>, /quest trials target <repo|quest-core>, or /quest trials profile.",
					"warning",
				);
			}
		}
	}

	async function queueSteeringNote(ctx: ExtensionContext, quest: QuestState, note: string, source: "command" | "quest-mode"): Promise<QuestState> {
		const originalStatus = quest.status;
		quest.steeringNotes.push(note);
		quest.pendingPlanRevisionRequests.push({
			id: randomUUID(),
			source: "steer",
			note,
			createdAt: Date.now(),
		});
		if (originalStatus === "running" || quest.activeRun) {
			quest.lastSummary = "Queued a steering note for the remaining plan.";
		} else if (originalStatus === "blocked" || originalStatus === "paused") {
			quest.lastSummary = "Steering note saved. The remaining plan will be revised on the next /quest resume.";
		}
		await saveQuest(quest);
		await appendQuestEvent(ctx.cwd, quest.id, { ts: Date.now(), type: "quest_steer", data: { note, source } });
		await applyQuestUi(ctx, quest);
		await emitNote(
			pi,
			ctx,
			originalStatus === "running" || quest.activeRun
				? "Steering note queued for the remaining plan."
				: "Steering note saved. Use `/quest resume` to revise the remaining plan.",
		);
		return quest;
	}

	async function markPlanReadyFromText(ctx: ExtensionContext, quest: QuestState, text: string) {
		const parsed = parseQuestPlanText(text);
		if (!parsed || quest.planHash === parsed.hash) return;
		quest.plan = parsed.plan;
		quest.planHash = parsed.hash;
		quest.title = parsed.plan.title;
		synthesizeAssertionsForQuestPlan(quest);
		quest.plan.humanQaChecklist = humanQaChecklist(quest);
		quest.status = "proposal_ready";
		quest.lastSummary = `${parsed.plan.summary} Review the proposal and use /quest accept when ready.`;
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, {
			ts: Date.now(),
			type: "quest_plan_updated",
			data: {
				featureCount: parsed.plan.features.length,
				milestoneCount: parsed.plan.milestones.length,
				assertionCount: quest.validationState?.assertions.length ?? 0,
			},
		});
		liveRun = null;
		planningEvents = [];
		pendingQuestControlOpen = ctx.hasUI && Boolean(ctx.ui.custom);
		await applyQuestUi(ctx, quest);
		await emitNote(pi, ctx, `Quest proposal captured. Review it with \`/quest\`, then use \`/quest accept\`.`);
	}

	async function applyPendingPlanRevision(ctx: ExtensionContext, quest: QuestState): Promise<QuestState> {
		if (!quest.plan || quest.pendingPlanRevisionRequests.length === 0) return quest;
		const requests = [...quest.pendingPlanRevisionRequests];
		liveRun = createLiveRunSnapshot("orchestrator", { milestoneId: currentMilestone(quest)?.id }, "replanning");
		await persistActiveRun(ctx, quest, {
			role: "orchestrator",
			kind: "replan",
			milestoneId: currentMilestone(quest)?.id,
			phase: "replanning",
			startedAt: Date.now(),
		});
		const { run, revisedPlan } = await executePlanRevision(
			quest,
			requests,
			currentOrDefaultModel(quest, "orchestrator"),
			currentWorkflows,
			activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target),
			undefined,
			async (snapshot) => {
				liveRun = snapshot;
				if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
					quest.activeRun.phase = snapshot.phase;
					await saveQuest(quest);
				}
				await applyQuestUi(ctx, quest);
			},
			async (pid) => {
				if (quest.activeRun) {
					quest.activeRun.pid = pid;
					await saveQuest(quest);
				}
			},
		);
		await writeWorkerRun(quest.cwd, quest.id, run);
		await writeQuestTraceBundle(quest.cwd, traceBundleFromWorkerRun(quest, run, activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target)));
		quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
		liveRun = null;
		await persistLearnedWorkflows(run);
		quest.activeRun = undefined;
		if (!run.ok || !revisedPlan) {
			quest.status = "blocked";
			quest.lastError = run.summary;
			quest.lastSummary = "Plan revision failed. Review the quest and try again.";
			await saveQuest(quest);
			await applyQuestUi(ctx, quest);
			return quest;
		}
		const mergedPlan = mergeRemainingPlan(quest.plan, revisedPlan);
		quest.plan = mergedPlan;
		quest.planHash = randomUUID();
		synthesizeAssertionsForQuestPlan(quest);
		quest.pendingPlanRevisionRequests = [];
		quest.lastSummary = "Remaining plan revised.";
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "quest_plan_revised", data: { requestCount: requests.length } });
		await applyQuestUi(ctx, quest);
		return quest;
	}

	async function completeQuest(ctx: ExtensionContext, quest: QuestState): Promise<QuestState> {
		quest.status = "completed";
		quest.shipReadiness = "validated_waiting_for_human_qa";
		quest.humanQaStatus = "pending";
		quest.completedAt = Date.now();
		quest.lastSummary = `Quest completed. Human QA is still required before shipping.\n${humanQaChecklist(quest).map((item) => `- ${item}`).join("\n")}`;
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "quest_completed" });
		await applyQuestUi(ctx, quest);
		await emitNote(pi, ctx, `Quest "${quest.plan?.title ?? quest.title}" completed. Human QA is still required before shipping.`);
		return quest;
	}

	async function runValidationPass(
		ctx: ExtensionContext,
		quest: QuestState,
		milestone: QuestMilestone,
		features: QuestFeature[],
		pass: "code_review" | "user_surface",
	): Promise<{ quest: QuestState; ok: boolean; issues: string[] }> {
		liveRun = createLiveRunSnapshot("validator", { milestoneId: milestone.id }, pass);
		await persistActiveRun(ctx, quest, {
			role: "validator",
			kind: "validator",
			milestoneId: milestone.id,
			phase: pass,
			startedAt: Date.now(),
		});
		const validator = await executeValidator(
			quest,
			milestone,
			features,
			currentOrDefaultModel(quest, "validator"),
			currentWorkflows,
			pass,
			activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target),
			undefined,
			async (snapshot) => {
				liveRun = snapshot;
				if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
					quest.activeRun.phase = snapshot.phase;
					await saveQuest(quest);
				}
				await applyQuestUi(ctx, quest);
			},
			async (pid) => {
				if (quest.activeRun) {
					quest.activeRun.pid = pid;
					await saveQuest(quest);
				}
			},
		);
		liveRun = null;
		await writeWorkerRun(quest.cwd, quest.id, validator);
		await writeQuestTraceBundle(quest.cwd, traceBundleFromWorkerRun(quest, validator, activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target)));
		quest.recentRuns = trimRecentRuns([validator, ...quest.recentRuns]);
		await persistLearnedWorkflows(validator);
		quest.activeRun = undefined;
		const assertions = relevantAssertionsForPass(quest, milestone.id, pass);
		if (!validator.ok || (validator.issues?.length ?? 0) > 0) {
			markAssertions(quest, assertions, pass === "user_surface" ? "limited" : "failed", validator.summary);
			appendCorrectiveFeatures(quest, milestone, validator.issues && validator.issues.length > 0 ? validator.issues : [validator.summary], assertions);
			return { quest, ok: false, issues: validator.issues ?? [validator.summary] };
		}
		markAssertions(quest, assertions, "passed", validator.summary);
		return { quest, ok: true, issues: [] };
	}

	async function runQuest(ctx: ExtensionContext, quest: QuestState): Promise<QuestState> {
		if (!quest.plan) {
			await emitNote(pi, ctx, "Quest has no approved proposal yet.", "warning");
			return quest;
		}
		if (quest.pendingPlanRevisionRequests.length > 0) {
			quest = await applyPendingPlanRevision(ctx, quest);
		}
		if (quest.status === "aborted") return quest;

		while (true) {
			const milestone = currentMilestone(quest);
			if (!milestone) return completeQuest(ctx, quest);
			quest.status = "running";
			milestone.status = "running";
			if (!quest.startedAt) quest.startedAt = Date.now();
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "milestone_started", data: { milestoneId: milestone.id, title: milestone.title } });
			await applyQuestUi(ctx, quest);

			while (true) {
				const feature = nextPendingFeature(quest, milestone.id);
				if (!feature) break;

				feature.status = "running";
				quest.lastError = undefined;
				liveRun = createLiveRunSnapshot("worker", { featureId: feature.id, milestoneId: milestone.id });
				await persistActiveRun(ctx, quest, {
					role: "worker",
					kind: "feature",
					featureId: feature.id,
					milestoneId: milestone.id,
					phase: liveRun.phase,
					startedAt: Date.now(),
				});
				const run = await executeFeatureWorker(
					quest,
					feature,
					milestone,
					currentOrDefaultModel(quest, "worker"),
					currentWorkflows,
					activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target),
					undefined,
					async (snapshot) => {
						liveRun = snapshot;
						if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
							quest.activeRun.phase = snapshot.phase;
							await saveQuest(quest);
						}
						await applyQuestUi(ctx, quest);
					},
					async (pid) => {
						if (quest.activeRun) {
							quest.activeRun.pid = pid;
							await saveQuest(quest);
						}
					},
				);
				liveRun = null;
				await writeWorkerRun(quest.cwd, quest.id, run);
				await writeQuestTraceBundle(quest.cwd, traceBundleFromWorkerRun(quest, run, activeProfileFor(quest.cwd, currentProfile, currentTrialState?.target)));
				quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
				await persistLearnedWorkflows(run);
				quest.activeRun = undefined;

				if (run.aborted) {
					markQuestAborted(quest);
				}
				if ((quest.status as string) === "aborted") {
					await saveQuest(quest);
					await applyQuestUi(ctx, quest);
					return quest;
				}
				if (!run.ok) {
					feature.status = "blocked";
					feature.lastError = run.stderr || run.summary;
					milestone.status = "blocked";
					quest.status = "blocked";
					quest.lastError = run.summary;
					quest.lastSummary = `Feature blocked: ${feature.title}`;
					await saveQuest(quest);
					await appendQuestEvent(quest.cwd, quest.id, {
						ts: Date.now(),
						type: "feature_blocked",
						data: { featureId: feature.id, title: feature.title, summary: run.summary },
					});
					await applyQuestUi(ctx, quest);
					await emitNote(pi, ctx, `Quest blocked on feature "${feature.title}". ${run.summary}`, "warning");
					return quest;
				}

				feature.status = "completed";
				feature.lastRunSummary = run.summary;
				feature.lastError = undefined;
				quest.lastSummary = `Completed feature: ${feature.title}`;
				await saveQuest(quest);
				await appendQuestEvent(quest.cwd, quest.id, {
					ts: Date.now(),
					type: "feature_completed",
					data: { featureId: feature.id, title: feature.title, summary: run.summary },
				});
				await applyQuestUi(ctx, quest);
			}

			const features = currentMilestoneFeatures(quest, milestone.id);
			const codePass = await runValidationPass(ctx, quest, milestone, features, "code_review");
			quest = codePass.quest;
			if (!codePass.ok) {
				milestone.status = "blocked";
				quest.status = "blocked";
				quest.lastError = codePass.issues.join("; ");
				quest.lastSummary = `Validator blocked milestone "${milestone.title}". Corrective features were appended before the next milestone can start.`;
				quest.pendingPlanRevisionRequests.push({
					id: randomUUID(),
					source: "validator",
					note: `Rework validator issues in "${milestone.title}" before continuing.`,
					createdAt: Date.now(),
					milestoneId: milestone.id,
					issues: codePass.issues,
				});
				await saveQuest(quest);
				await applyQuestUi(ctx, quest);
				await emitNote(pi, ctx, `Milestone "${milestone.title}" is blocked after code review.`, "warning");
				return quest;
			}

			const userPass = await runValidationPass(ctx, quest, milestone, features, "user_surface");
			quest = userPass.quest;
			if (!userPass.ok) {
				milestone.status = "blocked";
				quest.status = "blocked";
				quest.lastError = userPass.issues.join("; ");
				quest.lastSummary = `User-surface validation blocked milestone "${milestone.title}". Corrective features were appended before the next milestone can start.`;
				quest.pendingPlanRevisionRequests.push({
					id: randomUUID(),
					source: "validator",
					note: `Resolve user-surface validation issues in "${milestone.title}" before continuing.`,
					createdAt: Date.now(),
					milestoneId: milestone.id,
					issues: userPass.issues,
				});
				await saveQuest(quest);
				await applyQuestUi(ctx, quest);
				await emitNote(pi, ctx, `Milestone "${milestone.title}" is blocked after user-surface validation.`, "warning");
				return quest;
			}

			milestone.status = "completed";
			quest.lastSummary = `Validated milestone: ${milestone.title}`;
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "milestone_completed", data: { milestoneId: milestone.id, title: milestone.title } });
			await applyQuestUi(ctx, quest);
		}
	}

	async function handleQuestCommand(args: string, ctx: ExtensionContext) {
		const trimmed = args.trim();
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);

		if (!trimmed) {
			if (!currentQuest) {
				await emitNote(pi, ctx, `No active quest for this repo.\n\n- Quest mode: ${questModeEnabled ? "on" : "off"}\n- Use /quest new <goal> to create one\n- Use /quests to browse existing quests`);
				return;
			}
			await openQuestControl(ctx, currentQuest);
			return;
		}

		const [subcommand, ...rest] = trimmed.split(/\s+/);
		const remainder = rest.join(" ").trim();

		switch (subcommand) {
			case "trials": {
				await handleQuestTrialsCommand(remainder, ctx);
				return;
			}

			case "new": {
				if (!remainder) {
					await emitNote(pi, ctx, "Usage: /quest new <goal>", "warning");
					return;
				}
				if (currentQuest && !["completed", "aborted"].includes(currentQuest.status)) {
					await emitNote(pi, ctx, "There is already an active non-terminal quest in this repo. Use /quest to inspect it or /quests to switch.", "warning");
					return;
				}
				currentQuest = await createPlanningQuest(ctx, remainder);
				planningTurnActive = true;
				const prompt = `Let's plan a quest for this repository.\n\nGoal: ${remainder}\n\nAsk clarifying questions if needed. Use the quest tools to write the proposal when you are ready.`;
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
				return;
			}

			case "enter": {
				await setQuestMode(ctx, true);
				await emitNote(pi, ctx, "Quest mode enabled.");
				return;
			}

			case "exit": {
				await setQuestMode(ctx, false);
				await emitNote(pi, ctx, "Quest mode disabled.");
				return;
			}

			case "accept": {
				if (!(await ensureCurrentQuest(ctx))) return;
				if (!currentQuest || currentQuest.status !== "proposal_ready") {
					await emitNote(pi, ctx, "Use /quest accept only after the quest proposal reaches proposal_ready.", "warning");
					return;
				}
				if (!proposalReady(currentQuest)) {
					await emitNote(pi, ctx, "The quest proposal is incomplete. Ensure proposal, features, validation, and readiness artifacts are all captured first.", "warning");
					return;
				}
				currentQuest = await runQuest(ctx, currentQuest);
				return;
			}

			case "pause": {
				if (!(await ensureCurrentQuest(ctx))) return;
				if (!currentQuest) return;
				if (currentQuest.activeRun) {
					await emitNote(pi, ctx, "Quest is actively running. Use /quest abort to interrupt the active worker or validator.", "warning");
					return;
				}
				if (currentQuest.status === "planning" || currentQuest.status === "proposal_ready") {
					await emitNote(pi, ctx, "Planning is conversational. Use /quest exit to leave quest mode or keep refining the proposal.", "warning");
					return;
				}
				currentQuest.status = "paused";
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, { ts: Date.now(), type: "quest_paused" });
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, "Quest paused.");
				return;
			}

			case "resume": {
				if (!(await ensureCurrentQuest(ctx))) return;
				if (!currentQuest) return;
				if (!currentQuest.plan) {
					await emitNote(pi, ctx, "Quest has no approved proposal yet.", "warning");
					return;
				}
				if (currentQuest.status === "aborted") {
					prepareQuestForResume(currentQuest);
				}
				if (currentQuest.status !== "paused" && currentQuest.status !== "blocked" && currentQuest.status !== "aborted") {
					await emitNote(pi, ctx, "Use /quest resume only for paused, blocked, or aborted quests.", "warning");
					return;
				}
				currentQuest = await runQuest(ctx, currentQuest);
				return;
			}

			case "abort": {
				if (!(await ensureCurrentQuest(ctx))) return;
				if (!currentQuest?.activeRun) {
					await emitNote(pi, ctx, "Quest does not have an active worker, validator, or replan run to abort.", "warning");
					return;
				}
				const activePid = currentQuest.activeRun.pid;
				const summary = markQuestAborted(currentQuest);
				let terminationSummary = "No active child PID was recorded.";
				if (typeof activePid === "number") {
					const termination = await terminateQuestProcess(activePid);
					if (termination.signal) {
						terminationSummary = termination.terminated
							? `Sent ${termination.signal} to quest child process ${activePid}.`
							: `Sent ${termination.signal} to quest child process ${activePid}; waiting for shutdown.`;
					} else {
						terminationSummary = `Quest child process ${activePid} was not running when abort was requested.`;
					}
				}
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, {
					ts: Date.now(),
					type: "quest_abort_requested",
					data: { summary, pid: activePid, termination: terminationSummary },
				});
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, `${summary ?? "Quest abort requested."} ${terminationSummary}`.trim(), "warning");
				return;
			}

			case "model": {
				if (!(await ensureCurrentQuest(ctx))) return;
				if (!currentQuest) return;
				const [roleArg, ...specParts] = remainder.split(/\s+/);
				const role = roleFromArg(roleArg || "");
				if (!role || specParts.length === 0) {
					await emitNote(pi, ctx, "Usage: /quest model <orchestrator|worker|validator> <provider/model[:thinking]>", "warning");
					return;
				}
				const next = parseModelChoiceSpec(specParts.join(" "), currentOrDefaultModel(currentQuest, role));
				if (!next) {
					await emitNote(pi, ctx, "Invalid model spec. Expected provider/model[:thinking].", "warning");
					return;
				}
				currentQuest.roleModels[role] = next;
				syncQuestConfig(currentQuest);
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, {
					ts: Date.now(),
					type: "quest_role_model_changed",
					data: { role, model: `${next.provider}/${next.model}`, thinkingLevel: next.thinkingLevel },
				});
				if (role === "orchestrator" && currentQuest.status === "planning") {
					const model = ctx.modelRegistry.find(next.provider, next.model);
					if (model) {
						const success = await pi.setModel(model);
						if (success) pi.setThinkingLevel(next.thinkingLevel);
					}
				}
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, `${role} model set to ${modelLabel(next)}.`);
				return;
			}

			default: {
				await emitNote(
					pi,
					ctx,
					"Unknown /quest subcommand. Use /quest, /quest new <goal>, /quest enter, /quest exit, /quest accept, /quest pause, /quest resume, /quest abort, /quest trials, or /quest model <role> <provider/model[:thinking]>.",
					"warning",
				);
			}
		}
	}

	async function resolveQuestForTool(ctx: ExtensionContext, questId?: string): Promise<QuestState | null> {
		if (questId) return loadQuest(ctx.cwd, questId);
		return loadActiveQuest(ctx.cwd);
	}

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _context, theme) => new Text(theme.fg("accent", "[quest] ") + String(message.content), 0, 0));

	pi.registerTool({
		name: "quest_set_proposal",
		label: "quest_set_proposal",
		description: "Persist the current quest proposal, milestones, risks, environment, and human QA checklist.",
		promptSnippet: "Persist a quest proposal and milestone outline",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			title: Type.String(),
			summary: Type.String(),
			risks: Type.Optional(Type.Array(Type.String())),
			environment: Type.Optional(Type.Array(Type.String())),
			humanQaChecklist: Type.Optional(Type.Array(Type.String())),
			validationSummary: Type.Optional(Type.String()),
			proposalMarkdown: Type.Optional(Type.String()),
			milestones: Type.Array(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.String(),
					order: Type.Optional(Type.Number()),
					successCriteria: Type.Optional(Type.Array(Type.String())),
					validationPrompt: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }] };
			quest.title = params.title;
			quest.proposalMarkdown = params.proposalMarkdown;
			quest.plan = {
				title: params.title,
				summary: params.summary,
				goal: quest.goal,
				risks: params.risks ?? quest.plan?.risks ?? [],
				environment: params.environment ?? quest.plan?.environment ?? [],
				services: quest.plan?.services ?? [],
				validationSummary: params.validationSummary ?? quest.plan?.validationSummary,
				humanQaChecklist: params.humanQaChecklist ?? quest.plan?.humanQaChecklist ?? ["Review the primary user flows manually before shipping."],
				milestones: params.milestones.map((milestone: any, index: number) => ({
					id: milestone.id,
					order: milestone.order ?? index + 1,
					title: milestone.title,
					description: milestone.description,
					successCriteria: milestone.successCriteria ?? [],
					validationPrompt: milestone.validationPrompt,
					status: quest.plan?.milestones.find((existing) => existing.id === milestone.id)?.status ?? "pending",
				})),
				features: quest.plan?.features ?? [],
			};
			await saveQuest(quest);
			currentQuest = quest;
			await applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored proposal for ${params.title} with ${params.milestones.length} milestone(s).` }],
				details: { questId: quest.id, milestoneCount: params.milestones.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_set_features",
		label: "quest_set_features",
		description: "Persist the ordered feature list for the active quest.",
		promptSnippet: "Persist quest features and their assertion mapping",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			replaceExisting: Type.Optional(Type.Boolean()),
			features: Type.Array(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.String(),
					milestoneId: Type.String(),
					order: Type.Optional(Type.Number()),
					preconditions: Type.Optional(Type.Array(Type.String())),
					fulfills: Type.Optional(Type.Array(Type.String())),
					handoff: Type.Optional(Type.String()),
					workerPrompt: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest || !quest.plan) return { content: [{ type: "text", text: "No active quest proposal found." }] };
			const nextFeatures = params.features.map((feature: any, index: number) => ({
				id: feature.id,
				order: feature.order ?? index + 1,
				milestoneId: feature.milestoneId,
				title: feature.title,
				description: feature.description,
				preconditions: feature.preconditions ?? [],
				fulfills: feature.fulfills ?? [],
				status: quest.plan?.features.find((existing) => existing.id === feature.id)?.status ?? "pending",
				handoff: feature.handoff,
				workerPrompt: feature.workerPrompt,
			}));
			if (params.replaceExisting !== false) {
				quest.plan.features = nextFeatures;
			} else {
				const byId = new Map(quest.plan.features.map((feature) => [feature.id, feature]));
				for (const feature of nextFeatures) byId.set(feature.id, feature);
				quest.plan.features = [...byId.values()].sort((a, b) => a.order - b.order);
			}
			synthesizeAssertionsForQuestPlan(quest);
			await saveQuest(quest);
			currentQuest = quest;
			await applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored ${nextFeatures.length} feature(s).` }],
				details: { questId: quest.id, featureCount: quest.plan.features.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_set_validation",
		label: "quest_set_validation",
		description: "Persist validation readiness and assertion state for the active quest.",
		promptSnippet: "Persist quest validation readiness and assertions",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			readiness: Type.Optional(
				Type.Object({
					summary: Type.String(),
					checks: Type.Array(
						Type.Object({
							id: Type.String(),
							surface: Type.String(),
							description: Type.String(),
							status: Type.Union([Type.Literal("supported"), Type.Literal("limited"), Type.Literal("unsupported")]),
							commands: Type.Optional(Type.Array(Type.String())),
							evidence: Type.Optional(Type.Array(Type.String())),
							notes: Type.Optional(Type.String()),
						}),
					),
				}),
			),
			assertions: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						milestoneId: Type.String(),
						description: Type.String(),
						method: Type.Union([
							Type.Literal("code_review"),
							Type.Literal("procedure_review"),
							Type.Literal("user_surface"),
							Type.Literal("command"),
							Type.Literal("read_only"),
							Type.Literal("manual"),
							Type.Literal("mixed"),
						]),
						criticality: Type.Union([Type.Literal("critical"), Type.Literal("important"), Type.Literal("informational")]),
						status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("limited")])),
						evidence: Type.Optional(Type.Array(Type.String())),
						featureIds: Type.Optional(Type.Array(Type.String())),
						notes: Type.Optional(Type.String()),
						commands: Type.Optional(Type.Array(Type.String())),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }] };
			if (params.readiness) {
				quest.validationReadiness = {
					summary: params.readiness.summary,
					checks: params.readiness.checks.map((check: any) => ({
						id: check.id,
						surface: check.surface,
						description: check.description,
						status: check.status as ValidationSurfaceStatus,
						commands: check.commands ?? [],
						evidence: check.evidence ?? [],
						notes: check.notes,
					})),
				};
			}
			if (params.assertions) {
				quest.validationState = {
					assertions: params.assertions.map((assertion: any) => ({
						id: assertion.id,
						milestoneId: assertion.milestoneId,
						description: assertion.description,
						method: assertion.method,
						criticality: assertion.criticality,
						status: assertion.status ?? "pending",
						evidence: assertion.evidence ?? [],
						featureIds: assertion.featureIds ?? [],
						notes: assertion.notes,
						commands: assertion.commands ?? [],
					})),
					updatedAt: Date.now(),
				};
			}
			await saveQuest(quest);
			currentQuest = quest;
			await applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored validation data for ${quest.title}.` }],
				details: {
					questId: quest.id,
					assertionCount: quest.validationState?.assertions.length ?? 0,
					readinessCount: quest.validationReadiness?.checks.length ?? 0,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_set_services",
		label: "quest_set_services",
		description: "Persist service definitions and services.yaml content for the active quest.",
		promptSnippet: "Persist quest services and runtime assumptions",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			servicesYaml: Type.Optional(Type.String()),
			environment: Type.Optional(Type.Array(Type.String())),
			services: Type.Array(
				Type.Object({
					name: Type.String(),
					purpose: Type.String(),
					commands: Type.Array(Type.String()),
					ports: Type.Optional(Type.Array(Type.Number())),
					notes: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest || !quest.plan) return { content: [{ type: "text", text: "No active quest proposal found." }] };
			quest.plan.services = params.services.map((service: any) => ({
				name: service.name,
				purpose: service.purpose,
				commands: service.commands,
				ports: service.ports,
				notes: service.notes,
			}));
			if (params.environment) quest.plan.environment = params.environment;
			if (params.servicesYaml) quest.servicesYaml = params.servicesYaml;
			await saveQuest(quest);
			currentQuest = quest;
			await applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored ${params.services.length} service definition(s).` }],
				details: { questId: quest.id, serviceCount: params.services.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_write_skill",
		label: "quest_write_skill",
		description: "Write a generated quest skill under the quest or shared skill directory.",
		promptSnippet: "Write a quest-local or shared skill markdown file",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			name: Type.String(),
			markdown: Type.String(),
			shared: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }] };
			const paths = getQuestPaths(quest.cwd, quest.id);
			const dir = params.shared ? paths.sharedSkillsDir : paths.skillsDir;
			await mkdir(dir, { recursive: true });
			const file = join(dir, `${params.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.md`);
			await writeFile(file, `${params.markdown.trimEnd()}\n`, "utf-8");
			return {
				content: [{ type: "text", text: `Wrote skill ${params.name}.` }],
				details: { questId: quest.id, file, shared: params.shared === true },
			};
		},
	});

	pi.registerTool({
		name: "quest_update_state",
		label: "quest_update_state",
		description: "Update high-level quest state after proposal planning or orchestration checkpoints.",
		promptSnippet: "Update quest status or summary",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			status: Type.Optional(
				Type.Union([
					Type.Literal("planning"),
					Type.Literal("proposal_ready"),
					Type.Literal("running"),
					Type.Literal("paused"),
					Type.Literal("blocked"),
					Type.Literal("completed"),
					Type.Literal("aborted"),
				]),
			),
			lastSummary: Type.Optional(Type.String()),
			lastError: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }] };
			if (params.status) {
				if (params.status === "proposal_ready" && !proposalReady(quest)) {
					return { content: [{ type: "text", text: "Quest cannot move to proposal_ready until proposal, features, validation, and readiness artifacts are present." }] };
				}
				quest.status = params.status;
			}
			if (params.lastSummary) quest.lastSummary = params.lastSummary;
			if (params.lastError !== undefined) quest.lastError = params.lastError || undefined;
			await saveQuest(quest);
			currentQuest = quest;
			await applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Updated quest state to ${quest.status}.` }],
				details: { questId: quest.id, status: quest.status },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_set_profile",
		label: "quest_trials_set_profile",
		description: "Persist the active Trials profile and its editable surfaces.",
		promptSnippet: "Persist a Trials profile surface update",
		parameters: Type.Object({
			profileId: Type.Optional(Type.String()),
			target: Type.Optional(Type.Union([Type.Literal("repo"), Type.Literal("quest-core")])),
			title: Type.Optional(Type.String()),
			adoptedChange: Type.Optional(Type.String()),
			promptSurfaces: Type.Optional(
				Type.Object({
					planningPolicy: Type.Optional(Type.String()),
					workerPolicy: Type.Optional(Type.String()),
					validatorCodeReviewPolicy: Type.Optional(Type.String()),
					validatorUserSurfacePolicy: Type.Optional(Type.String()),
					readinessPolicy: Type.Optional(Type.String()),
					revisionPolicy: Type.Optional(Type.String()),
				}),
			),
			modelPolicy: Type.Optional(
				Type.Object({
					preferSameModelFamily: Type.Optional(Type.Boolean()),
					preferValidatorDivergence: Type.Optional(Type.Boolean()),
				}),
			),
			verificationBudget: Type.Optional(
				Type.Object({
					workerAttempts: Type.Optional(Type.Number()),
					validatorAttempts: Type.Optional(Type.Number()),
					correctiveFeatureBudget: Type.Optional(Type.Number()),
				}),
			),
			contextPolicy: Type.Optional(
				Type.Object({
					spillThresholdChars: Type.Optional(Type.Number()),
					spillLongOutputsToReports: Type.Optional(Type.Boolean()),
					maxInlineEvidenceLines: Type.Optional(Type.Number()),
				}),
			),
			workflowHintPolicy: Type.Optional(
				Type.Object({
					maxSharedHints: Type.Optional(Type.Number()),
					promotePrerequisiteHints: Type.Optional(Type.Boolean()),
					promoteFailureHints: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trialState = await loadQuestTrialState(ctx.cwd, { ensure: true });
			const profile = await loadQuestProfile(ctx.cwd, params.profileId ?? trialState.activeProfileId, {
				ensure: true,
				target: params.target ?? trialState.target,
			});
			const next = applyQuestProfilePatch(profile, {
				promptSurfaces: params.promptSurfaces,
				modelPolicy: params.modelPolicy,
				verificationBudget: params.verificationBudget,
				contextPolicy: params.contextPolicy,
				workflowHintPolicy: params.workflowHintPolicy,
				adoptedChange: params.adoptedChange,
			});
			if (params.title) next.title = params.title;
			if (params.target) next.target = params.target;
			await saveQuestProfile(ctx.cwd, next);
			currentProfile = next;
			return {
				content: [{ type: "text", text: `Updated Trials profile ${next.id}.` }],
				details: { profileId: next.id, target: next.target },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_record_trace_case",
		label: "quest_trials_record_trace_case",
		description: "Add a Quest trace replay case to the trace-replays dataset.",
		promptSnippet: "Persist a Quest trace replay case",
		parameters: Type.Object({
			runId: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dataset = await replayQuestRunIntoTrialDataset(ctx.cwd, params.runId);
			if (!dataset) {
				return { content: [{ type: "text", text: `No Quest trace matched ${params.runId}.` }] };
			}
			return {
				content: [{ type: "text", text: `Updated ${dataset.id} with replay cases for ${params.runId}.` }],
				details: { datasetId: dataset.id, caseCount: dataset.cases.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_record_experiment",
		label: "quest_trials_record_experiment",
		description: "Persist a Trials experiment record.",
		promptSnippet: "Persist a Trials experiment record",
		parameters: Type.Object({
			id: Type.String(),
			target: Type.Union([Type.Literal("repo"), Type.Literal("quest-core")]),
			profileId: Type.String(),
			state: Type.Union([
				Type.Literal("planned"),
				Type.Literal("running"),
				Type.Literal("rejected"),
				Type.Literal("applied"),
				Type.Literal("failed"),
				Type.Literal("stopped"),
			]),
			summary: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await loadQuestTrialState(ctx.cwd, { ensure: true });
			const experiment: QuestExperiment = {
				id: params.id,
				projectId: state.projectId,
				target: params.target,
				profileId: params.profileId,
				state: params.state,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				baselineScores: [],
				candidateScores: [],
				spotCheckCaseIds: [],
				heldOutCaseIds: [],
				tracesAnalyzed: [],
				summary: params.summary,
			};
			await saveQuestExperiment(ctx.cwd, experiment);
			return {
				content: [{ type: "text", text: `Recorded Trials experiment ${params.id}.` }],
				details: { experimentId: params.id },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_set_scores",
		label: "quest_trials_set_scores",
		description: "Update baseline and candidate score summaries for a Trials experiment.",
		promptSnippet: "Persist Trials experiment scores",
		parameters: Type.Object({
			experimentId: Type.String(),
			baselineScores: Type.Array(questExperimentScoreSchema),
			candidateScores: Type.Array(questExperimentScoreSchema),
			summary: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const experiment = await loadQuestExperiment(ctx.cwd, params.experimentId);
			if (!experiment) return { content: [{ type: "text", text: "Experiment not found." }] };
			experiment.baselineScores = params.baselineScores as QuestExperiment["baselineScores"];
			experiment.candidateScores = params.candidateScores as QuestExperiment["candidateScores"];
			if (params.summary) experiment.summary = params.summary;
			await saveQuestExperiment(ctx.cwd, experiment);
			return {
				content: [{ type: "text", text: `Updated scores for experiment ${params.experimentId}.` }],
				details: { experimentId: params.experimentId },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_apply_candidate",
		label: "quest_trials_apply_candidate",
		description: "Apply a Trials candidate patch to the active profile.",
		promptSnippet: "Apply a Trials candidate patch",
		parameters: Type.Object({
			adoptedChange: Type.String(),
			promptSurfaces: Type.Optional(questPromptSurfacesPatchSchema),
			modelPolicy: Type.Optional(questModelPolicyPatchSchema),
			verificationBudget: Type.Optional(questVerificationBudgetPatchSchema),
			contextPolicy: Type.Optional(questContextPolicyPatchSchema),
			workflowHintPolicy: Type.Optional(questWorkflowHintPolicyPatchSchema),
			traceGrading: Type.Optional(questTraceGradingPatchSchema),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trialState = await loadQuestTrialState(ctx.cwd, { ensure: true });
			const profile = await loadQuestProfile(ctx.cwd, trialState.activeProfileId, { ensure: true, target: trialState.target });
			const next = applyQuestProfilePatch(profile, {
				adoptedChange: params.adoptedChange,
				promptSurfaces: params.promptSurfaces,
				modelPolicy: params.modelPolicy,
				verificationBudget: params.verificationBudget,
				contextPolicy: params.contextPolicy,
				workflowHintPolicy: params.workflowHintPolicy,
				traceGrading: params.traceGrading,
			});
			await saveQuestProfile(ctx.cwd, next);
			currentProfile = next;
			return {
				content: [{ type: "text", text: `Applied candidate patch to ${next.id}.` }],
				details: { profileId: next.id, adoptedChanges: next.adoptedChanges.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_trials_update_state",
		label: "quest_trials_update_state",
		description: "Update high-level Trials state such as target, active experiment, or summary.",
		promptSnippet: "Update Trials state",
		parameters: Type.Object({
			target: Type.Optional(Type.Union([Type.Literal("repo"), Type.Literal("quest-core")])),
			activeProfileId: Type.Optional(Type.String()),
			activeExperimentId: Type.Optional(Type.String()),
			status: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("stopped"), Type.Literal("blocked")])),
			lastSummary: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await loadQuestTrialState(ctx.cwd, { ensure: true });
			if (params.target) state.target = params.target;
			if (params.activeProfileId) state.activeProfileId = params.activeProfileId;
			if (params.activeExperimentId !== undefined) state.activeExperimentId = params.activeExperimentId || undefined;
			if (params.status) state.status = params.status;
			if (params.lastSummary !== undefined) state.lastSummary = params.lastSummary || undefined;
			await saveQuestTrialState(ctx.cwd, state);
			currentTrialState = state;
			return {
				content: [{ type: "text", text: `Trials state updated to ${state.status}.` }],
				details: { target: state.target, profileId: state.activeProfileId, experimentId: state.activeExperimentId },
			};
		},
	});

	pi.registerCommand("quest", {
		description: "Open Quest Control or operate on the active quest",
		getArgumentCompletions: (prefix) => {
			const options = ["new", "enter", "exit", "accept", "pause", "resume", "abort", "model", "trials"];
			return options.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
		},
		handler: handleQuestCommand,
	});

	pi.registerCommand("quests", {
		description: "List and select quests for the current project",
		handler: async (_args, ctx) => {
			await showQuestList(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const questModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === QUEST_MODE_ENTRY)
			.pop() as { data?: { enabled?: boolean } } | undefined;
		const questDashboardEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === QUEST_DASHBOARD_ENTRY)
			.pop() as { data?: { tab?: DashboardTab } } | undefined;
		questModeEnabled = questModeEntry?.data?.enabled === true;
		dashboardTab = DASHBOARD_TABS.includes(questDashboardEntry?.data?.tab ?? "summary")
			? (questDashboardEntry?.data?.tab as DashboardTab)
			: "summary";
		planningTurnActive = false;
		await pruneQuestStorage(ctx.cwd);
		await loadQuestForContext(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		if (!questModeEnabled) return { action: "continue" as const };

		const trimmed = event.text.trim();
		if (!trimmed) return { action: "continue" as const };

		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);

		if (!currentQuest) {
			currentQuest = await createPlanningQuest(ctx, trimmed);
			planningTurnActive = true;
			return {
				action: "transform" as const,
				text: `Let's plan a quest for this repository.\n\nGoal: ${trimmed}\n\nAsk clarifying questions if needed. Use the quest tools to persist the proposal when you are ready.`,
			};
		}

		if (currentQuest.status === "planning" || currentQuest.status === "proposal_ready") {
			planningTurnActive = true;
			await applyQuestUi(ctx, currentQuest);
			return { action: "continue" as const };
		}

		if (currentQuest.status === "running" || currentQuest.status === "paused" || currentQuest.status === "blocked") {
			currentQuest = await queueSteeringNote(ctx, currentQuest, trimmed, "quest-mode");
			return { action: "handled" as const };
		}

		if (currentQuest.status === "completed" || currentQuest.status === "aborted") {
			await emitNote(pi, ctx, "Plain input is not captured for completed or aborted quests. Start or select another quest first.", "warning");
			return { action: "handled" as const };
		}

		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		const planningAllowed = planningTurnActive || !ctx.hasUI;
		if (!planningAllowed || !currentQuest || (currentQuest.status !== "planning" && currentQuest.status !== "proposal_ready")) return;
		planningEvents = [];
		planningStartedAt = Date.now();
		liveRun = createLiveRunSnapshot("orchestrator", {}, "planning");
		await applyQuestUi(ctx, currentQuest);
		return {
			message: {
				customType: "pi-quest-planning",
				content: planningInstructions(currentQuest, currentWorkflows, activeProfileFor(ctx.cwd, currentProfile, currentTrialState?.target)),
				display: false,
			},
		};
	});

	const planningRuntimeEvent = async (event: any, ctx: ExtensionContext) => {
		if (!planningTurnActive && ctx.hasUI) return;
		currentQuest = await loadActiveQuest(ctx.cwd);
		if (!currentQuest || (currentQuest.status !== "planning" && currentQuest.status !== "proposal_ready")) return;
		const next = applyAgentEventToSnapshot(liveRun ?? createLiveRunSnapshot("orchestrator", {}), event, 60, planningEvents);
		liveRun = next.snapshot;
		planningEvents = next.events;
		await applyQuestUi(ctx, currentQuest);
	};

	pi.on("message_update", planningRuntimeEvent);
	pi.on("tool_execution_start", planningRuntimeEvent);
	pi.on("tool_execution_update", planningRuntimeEvent);
	pi.on("tool_execution_end", planningRuntimeEvent);
	pi.on("turn_end", planningRuntimeEvent);

	pi.on("agent_end", async (event, ctx) => {
		currentQuest = await loadActiveQuest(ctx.cwd);
		const planningAllowed = planningTurnActive || !ctx.hasUI;
		if (!planningAllowed || !currentQuest || (currentQuest.status !== "planning" && currentQuest.status !== "proposal_ready")) {
			planningTurnActive = false;
			return;
		}
		const next = applyAgentEventToSnapshot(liveRun ?? createLiveRunSnapshot("orchestrator", {}), event, 60, planningEvents);
		liveRun = next.snapshot;
		planningEvents = next.events;
		const text = event.messages ? event.messages.map((msg: any) => msg?.content?.map?.((part: any) => part?.text || "").join("\n") || "").join("\n") : "";
		if (text && currentQuest.status === "planning") {
			await markPlanReadyFromText(ctx, currentQuest, text);
		}
		const planningProfile = activeProfileFor(ctx.cwd, currentProfile, currentTrialState?.target);
		await writeQuestTraceBundle(
			ctx.cwd,
			traceBundleFromPlanningSession(
				currentQuest,
				planningEvents,
				currentOrDefaultModel(currentQuest, "orchestrator"),
				planningProfile,
				currentQuest.lastSummary ?? truncate(text, 240),
				currentQuest.status === "proposal_ready",
				planningStartedAt || Date.now(),
				Date.now(),
				liveRun?.latestMessage,
			),
		);
		liveRun = null;
		planningTurnActive = false;
		planningStartedAt = 0;
		await applyQuestUi(ctx, currentQuest);
		if (pendingQuestControlOpen && currentQuest?.status === "proposal_ready") {
			pendingQuestControlOpen = false;
			await openQuestControl(ctx, currentQuest);
		}
	});
}
