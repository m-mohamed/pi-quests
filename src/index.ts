import { createHash, randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { mergeRemainingPlan, parseQuestPlanText, planningInstructions } from "./plan-core.js";
import { describeActiveRun, markQuestAborted, prepareQuestForResume, terminateQuestProcess } from "./runtime-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import {
	appendQuestEvent,
	createQuest,
	listProjectQuests,
	loadActiveQuest,
	loadLearnedWorkflows,
	loadQuest,
	questIsTerminal,
	pruneQuestStorage,
	saveLearnedWorkflows,
	saveQuest,
	switchActiveQuest,
	trimRecentRuns,
	writeWorkerRun,
} from "./state.js";
import { executeFeatureWorker, executePlanRevision, executeValidator } from "./workers.js";
import { deriveLearnedWorkflows, mergeLearnedWorkflows } from "./workflows.js";
import type {
	LearnedWorkflow,
	LiveRunSnapshot,
	QuestFeature,
	QuestMilestone,
	QuestPlanRevisionRequest,
	QuestRole,
	QuestState,
	QuestActiveRun,
	ModelChoice,
	ThinkingLevel,
	WorkerEventRecord,
} from "./types.js";

const CUSTOM_MESSAGE_TYPE = "pi-quests";
const STATUS_KEY = "pi-quests";
const WIDGET_KEY = "pi-quests";
const QUEST_MODE_ENTRY = "quest-mode";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ROLE_NAMES: QuestRole[] = ["orchestrator", "worker", "validator"];

function createDefaultModelChoice(model: Model<any> | null, thinkingLevel: ThinkingLevel): ModelChoice {
	return {
		provider: model?.provider ?? "openai-codex",
		model: model?.id ?? "gpt-5.4",
		thinkingLevel,
	};
}

function modelLabel(choice: ModelChoice | undefined): string {
	if (!choice) return "inherit";
	return `${choice.provider}/${choice.model} @ ${choice.thinkingLevel}`;
}

function truncate(text: string, max = 120): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}

function currentMilestone(quest: QuestState): QuestMilestone | undefined {
	if (!quest.plan) return undefined;
	for (const milestone of quest.plan.milestones) {
		if (milestone.status !== "completed") return milestone;
	}
	return undefined;
}

function currentMilestoneFeatures(quest: QuestState, milestoneId: string): QuestFeature[] {
	return (quest.plan?.features ?? []).filter((feature) => feature.milestoneId === milestoneId);
}

function nextPendingFeature(quest: QuestState, milestoneId: string): QuestFeature | undefined {
	return currentMilestoneFeatures(quest, milestoneId).find((feature) => feature.status === "pending");
}

function currentOrDefaultModel(quest: QuestState, role: QuestRole): ModelChoice {
	return quest.roleModels[role] ?? quest.defaultModel;
}

function roleFromArg(arg: string): QuestRole | null {
	const normalized = arg.trim().toLowerCase();
	return ROLE_NAMES.includes(normalized as QuestRole) ? (normalized as QuestRole) : null;
}

function latestAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((part: { type: string }) => part.type === "text")
			.map((part: { text: string }) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function supportsXhigh(choice: ModelChoice): boolean {
	return choice.provider === "openai-codex" && /^gpt-5\./.test(choice.model);
}

function availableThinkingLevels(choice: ModelChoice): ThinkingLevel[] {
	if (!supportsXhigh(choice)) return THINKING_LEVELS.filter((level) => level !== "xhigh");
	return THINKING_LEVELS;
}

function summarizeRecentRuns(quest: QuestState): string {
	if (quest.recentRuns.length === 0) return "none";
	return quest.recentRuns
		.slice(0, 4)
		.map((run) => `[${run.role}] ${run.summary}${run.latestToolName ? ` · ${run.latestToolName}` : ""}`)
		.join("\n");
}

function questAwaitingHumanQa(quest: QuestState): boolean {
	return quest.status === "completed" && quest.shipReadiness === "validated_waiting_for_human_qa" && quest.humanQaStatus !== "approved";
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

function summarizeQuest(
	quest: QuestState,
	workflows: LearnedWorkflow[],
	liveRun: LiveRunSnapshot | null,
	questModeEnabled: boolean,
): string {
	const featureCount = quest.plan?.features.length ?? 0;
	const done = quest.plan?.features.filter((feature) => feature.status === "completed").length ?? 0;
	const milestone = currentMilestone(quest);
	const weakWarnings = quest.plan?.validationContract.weakValidationWarnings.length ?? 0;
	const activeRun = questActiveRun(quest, liveRun);

	return `# Quest: ${quest.plan?.title ?? quest.title}

- Status: ${quest.status}
- Proposal: ${quest.plan ? "captured" : "not ready"}
- Human QA: ${quest.humanQaStatus}
- Ship readiness: ${quest.shipReadiness}
- Goal: ${quest.goal}
- Default model: ${modelLabel(quest.defaultModel)}
- Orchestrator model: ${modelLabel(currentOrDefaultModel(quest, "orchestrator"))}
- Worker model: ${modelLabel(currentOrDefaultModel(quest, "worker"))}
- Validator model: ${modelLabel(currentOrDefaultModel(quest, "validator"))}
- Features: ${done}/${featureCount} complete
- Active milestone: ${milestone ? `${milestone.title} [${milestone.status}]` : "none"}
- Validation criteria: ${quest.plan?.validationContract.criteria.length ?? 0}
- Weak validation warnings: ${weakWarnings}
- Pending plan revisions: ${quest.pendingPlanRevisionRequests.length}
- Learned workflows: ${workflows.length}
- Quest mode: ${questModeEnabled ? "on" : "off"}
- Next action: ${questAwaitingHumanQa(quest) ? "/quest approve" : quest.status === "ready" ? "/quest accept" : quest.status === "paused" || quest.status === "aborted" ? "/quest resume" : quest.status === "running" ? "/quest abort" : "none"}
- Active run: ${liveRun ? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` · ${liveRun.latestToolName}` : ""}${liveRun.latestMessage ? ` · ${truncate(liveRun.latestMessage, 80)}` : ""}` : activeRun ? `${describeActiveRun(quest, activeRun)} · ${activeRun.phase}${activeRun.abortRequestedAt ? " · abort requested" : ""}` : "idle"}
${quest.lastSummary ? `- Last summary: ${quest.lastSummary}` : ""}
${quest.lastError ? `- Last error: ${quest.lastError}` : ""}

Recent runs:
${summarizeRecentRuns(quest)}

${quest.plan?.validationContract.weakValidationWarnings.length ? `Validation warnings:\n${quest.plan.validationContract.weakValidationWarnings.map((warning) => `- ${warning}`).join("\n")}` : "Validation warnings:\n- none"}

${quest.pendingPlanRevisionRequests.length ? `Pending revision requests:\n${quest.pendingPlanRevisionRequests.map((request) => `- [${request.source}] ${request.note}`).join("\n")}` : "Pending revision requests:\n- none"}`;
}

function questWidgetLines(
	quest: QuestState,
	workflows: LearnedWorkflow[],
	liveRun: LiveRunSnapshot | null,
	questModeEnabled: boolean,
): string[] {
	const lines = [`quest:${quest.plan?.title ?? quest.title} [${quest.status}]`, `default:${modelLabel(quest.defaultModel)}`];
	const activeRun = questActiveRun(quest, liveRun);
	const milestone = currentMilestone(quest);
	lines.push(`mode:${questModeEnabled ? "on" : "off"}`);
	if (milestone) lines.push(`milestone:${milestone.title} [${milestone.status}]`);
	if (quest.plan) {
		const completed = quest.plan.features.filter((feature) => feature.status === "completed").length;
		lines.push(`features:${completed}/${quest.plan.features.length}`);
		lines.push(`validation:${quest.plan.validationContract.criteria.length} checks`);
		if (quest.plan.validationContract.weakValidationWarnings.length > 0) {
			lines.push(`weak-validation:${quest.plan.validationContract.weakValidationWarnings.length}`);
		}
	}
	lines.push(`orchestrator:${modelLabel(currentOrDefaultModel(quest, "orchestrator"))}`);
	lines.push(`worker:${modelLabel(currentOrDefaultModel(quest, "worker"))}`);
	lines.push(`validator:${modelLabel(currentOrDefaultModel(quest, "validator"))}`);
	lines.push(`qa:${quest.humanQaStatus}`);
	lines.push(`ship:${quest.shipReadiness}`);
	lines.push(`workflows:${workflows.length}`);
	if (quest.pendingPlanRevisionRequests.length > 0) lines.push(`replan:${quest.pendingPlanRevisionRequests.length} pending`);
	if (liveRun) {
		lines.push(`active:${liveRun.role}/${liveRun.phase}`);
		if (liveRun.latestToolName) lines.push(`tool:${liveRun.latestToolName} ${truncate(liveRun.latestToolSummary || "", 48)}`.trim());
		if (liveRun.latestMessage) lines.push(`msg:${truncate(liveRun.latestMessage, 60)}`);
	} else if (activeRun) {
		lines.push(`active:${activeRun.role}/${activeRun.phase}`);
		if (activeRun.abortRequestedAt) lines.push("abort:requested");
	}
	return lines;
}

async function emitNote(pi: ExtensionAPI, ctx: ExtensionContext, content: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(content, level);
	pi.sendMessage({ customType: CUSTOM_MESSAGE_TYPE, content, display: true }, { triggerTurn: false });
}

async function chooseModelChoice(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initial: ModelChoice,
	applyNow: boolean,
): Promise<ModelChoice | null> {
	if (!ctx.hasUI) {
		await emitNote(pi, ctx, "Model selection requires interactive mode.", "warning");
		return null;
	}

	const available = await ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		await emitNote(pi, ctx, "No available models found.", "warning");
		return null;
	}

	const labels = available.map((model) => `${model.provider}/${model.id}`);
	const selectedLabel = await ctx.ui.select("Quest model", labels);
	if (!selectedLabel) return null;

	const selectedModel = available.find((model) => `${model.provider}/${model.id}` === selectedLabel);
	if (!selectedModel) return null;

	const choice: ModelChoice = {
		provider: selectedModel.provider,
		model: selectedModel.id,
		thinkingLevel: initial.thinkingLevel,
	};

	const thinking = await ctx.ui.select("Thinking level", availableThinkingLevels(choice), choice.thinkingLevel);
	if (!thinking) return null;
	choice.thinkingLevel = thinking as ThinkingLevel;

	if (applyNow) {
		const success = await pi.setModel(selectedModel);
		if (success) {
			pi.setThinkingLevel(choice.thinkingLevel);
		} else {
			await emitNote(pi, ctx, `Model ${selectedLabel} is not currently available for the live session.`, "warning");
		}
	}

	return choice;
}

export default function questExtension(pi: ExtensionAPI) {
	let currentQuest: QuestState | null = null;
	let currentWorkflows: LearnedWorkflow[] = [];
	let liveRun: LiveRunSnapshot | null = null;
	let planningEvents: WorkerEventRecord[] = [];
	let questModeEnabled = false;
	let planningTurnActive = false;

	function persistQuestMode() {
		pi.appendEntry(QUEST_MODE_ENTRY, { enabled: questModeEnabled });
	}

	async function applyQuestUi(ctx: ExtensionContext, quest: QuestState | null) {
		if (!ctx.hasUI) return;
		if (!quest) {
			if (questModeEnabled) {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "quest:mode"));
				ctx.ui.setWidget(WIDGET_KEY, ["quest-mode:on", "active:none"]);
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
			return;
		}
		const liveSummary = liveRun ? ` · ${liveRun.role}:${liveRun.phase}` : "";
		const modeSuffix = questModeEnabled ? " · mode:on" : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `quest:${quest.status}${liveSummary}${modeSuffix}`));
		ctx.ui.setWidget(WIDGET_KEY, questWidgetLines(quest, currentWorkflows, liveRun, questModeEnabled));
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
		if (!currentQuest || currentQuest.status !== "planning") {
			liveRun = null;
			planningEvents = [];
		}
		await applyQuestUi(ctx, currentQuest);
	}

	async function showStatus(ctx: ExtensionContext) {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		if (!currentQuest) {
			await emitNote(
				pi,
				ctx,
				`No active quest for this repo.

- Quest mode: ${questModeEnabled ? "on" : "off"}
- Use /enter-quest for interactive planning
- Use /quest new <goal> for explicit non-interactive creation
- Use /quests to browse existing quests`,
			);
			await applyQuestUi(ctx, null);
			return;
		}
		await emitNote(pi, ctx, summarizeQuest(currentQuest, currentWorkflows, liveRun, questModeEnabled));
		await applyQuestUi(ctx, currentQuest);
	}

	async function setQuestMode(ctx: ExtensionContext, enabled: boolean) {
		questModeEnabled = enabled;
		if (!enabled) planningTurnActive = false;
		persistQuestMode();
		await applyQuestUi(ctx, currentQuest);
	}

	function questPlanningPrompt(goal: string): string {
		return `Let's plan a quest for this repository.\n\nGoal: ${goal}\n\nAsk clarifying questions if needed. When the proposal is ready, return the quest JSON in the required schema.`;
	}

	function questListLines(quests: QuestState[], activeQuestId: string | null): string[] {
		return quests.map((quest) => {
			const marker = quest.id === activeQuestId ? "*" : " ";
			const updated = new Date(quest.updatedAt).toLocaleString();
			return `${marker} ${quest.id} · ${quest.title} · ${quest.status} · ${updated}`;
		});
	}

	async function createPlanningQuest(
		ctx: ExtensionContext,
		goal: string,
		options: { triggerPlanningTurn: boolean },
	): Promise<QuestState> {
		const modelChoice = createDefaultModelChoice(ctx.model ?? null, pi.getThinkingLevel() as ThinkingLevel);
		currentQuest = await createQuest(ctx.cwd, goal, modelChoice);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		await pruneQuestStorage();
		currentQuest.lastSummary = options.triggerPlanningTurn
			? "Quest created. Planning will start immediately."
			: "Quest created in planning mode. Send a follow-up prompt to continue planning.";
		await saveQuest(currentQuest);
		await applyQuestUi(ctx, currentQuest);
		return currentQuest;
	}

	async function queueSteeringNote(
		ctx: ExtensionContext,
		quest: QuestState,
		note: string,
		source: "command" | "quest-mode",
	): Promise<QuestState> {
		const originalStatus = quest.status;
		quest.steeringNotes.push(note);

		if (quest.status === "planning") {
			planningTurnActive = true;
			await saveQuest(quest);
			await appendQuestEvent(ctx.cwd, quest.id, {
				ts: Date.now(),
				type: "quest_steer",
				data: { note, source },
			});
			if (ctx.isIdle()) {
				pi.sendUserMessage(note);
			} else {
				pi.sendUserMessage(note, { deliverAs: "followUp" });
			}
			await applyQuestUi(ctx, quest);
			await emitNote(pi, ctx, "Planning follow-up sent to the active quest.");
			return quest;
		}

		if (quest.status === "completed") {
			await saveQuest(quest);
			await appendQuestEvent(ctx.cwd, quest.id, {
				ts: Date.now(),
				type: "quest_steer_saved",
				data: { note, source },
			});
			await applyQuestUi(ctx, quest);
			await emitNote(pi, ctx, "Active quest is already completed. The note was saved, but completed quests are not reopened.", "warning");
			return quest;
		}

		quest.pendingPlanRevisionRequests.push({
			id: randomUUID(),
			source: "steer",
			note,
			createdAt: Date.now(),
		});

		if (originalStatus === "running" || quest.activeRun) {
			quest.lastSummary = "Queued a steering note for the remaining plan.";
		} else if (originalStatus === "ready") {
			quest.status = "paused";
			quest.lastSummary = "Steering note saved. Apply the revision with /quest resume before accepting the quest.";
		} else if (originalStatus === "paused") {
			quest.lastSummary = "Steering note saved. The remaining plan will be revised on the next /quest resume.";
		} else if (originalStatus === "aborted") {
			quest.lastSummary = "Steering note saved. The remaining plan will be revised on the next /quest resume.";
		}

		await saveQuest(quest);
		await appendQuestEvent(ctx.cwd, quest.id, {
			ts: Date.now(),
			type: "quest_steer",
			data: { note, source },
		});
		await applyQuestUi(ctx, quest);

		if (originalStatus === "running" || quest.activeRun) {
			await emitNote(pi, ctx, "Steering note queued for the remaining plan. Use /quest abort if you need to interrupt the active run.", "warning");
		} else if (originalStatus === "ready") {
			await emitNote(pi, ctx, "Steering note saved. Use /quest resume to revise the remaining plan before accepting the quest.");
		} else {
			await emitNote(pi, ctx, "Steering note saved. The remaining plan will be revised on the next /quest resume.");
		}
		return quest;
	}

	async function showQuestList(ctx: ExtensionContext) {
		const quests = await listProjectQuests(ctx.cwd);
		currentQuest = await loadActiveQuest(ctx.cwd);
		const activeQuestId = currentQuest?.id ?? null;
		if (quests.length === 0) {
			await emitNote(
				pi,
				ctx,
				`No quests found for this repo.

- Use /enter-quest for interactive planning
- Use /quest new <goal> for explicit creation`,
			);
			await applyQuestUi(ctx, currentQuest);
			return;
		}

		if (!ctx.hasUI) {
			await emitNote(pi, ctx, `Project quests:\n${questListLines(quests, activeQuestId).map((line) => `- ${line}`).join("\n")}`);
			await applyQuestUi(ctx, currentQuest);
			return;
		}

		const labels = quests.map((quest) => {
			const marker = quest.id === activeQuestId ? "* " : "";
			return `${marker}${quest.title} · ${quest.status} · ${quest.id}`;
		});
		const selected = await ctx.ui.select("Project quests", labels);
		if (!selected) {
			await applyQuestUi(ctx, currentQuest);
			return;
		}
		const selectedQuest = quests[labels.indexOf(selected)];
		if (!selectedQuest) {
			await applyQuestUi(ctx, currentQuest);
			return;
		}

		currentQuest = await switchActiveQuest(ctx.cwd, selectedQuest.id);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		await applyQuestUi(ctx, currentQuest);
		await emitNote(pi, ctx, `Active quest set to "${selectedQuest.title}". Use /quest to inspect it.`);
	}

	async function markPlanReady(ctx: ExtensionContext, quest: QuestState, text: string) {
		const parsed = parseQuestPlanText(text);
		if (!parsed) return;
		if (quest.planHash === parsed.hash) return;

		quest.plan = parsed.plan;
		quest.planHash = parsed.hash;
		quest.title = parsed.plan.title;
		quest.status = "ready";
		quest.lastSummary = `${parsed.plan.summary} Review the proposal and validation contract, then use /quest accept.`;
		quest.lastError = undefined;
		quest.pendingPlanRevisionRequests = [];
		quest.planRevisions = [
			{
				id: randomUUID(),
				source: "initial" as const,
				summary: "Initial quest proposal captured.",
				hash: parsed.hash,
				createdAt: Date.now(),
				requestIds: [],
			},
			...quest.planRevisions,
		].slice(0, 12);
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, {
			ts: Date.now(),
			type: "quest_plan_updated",
			data: {
				featureCount: parsed.plan.features.length,
				milestoneCount: parsed.plan.milestones.length,
				validationCriteria: parsed.plan.validationContract.criteria.length,
				weakValidationWarnings: parsed.plan.validationContract.weakValidationWarnings.length,
			},
		});
		liveRun = null;
		planningEvents = [];
		await applyQuestUi(ctx, quest);
		await emitNote(
			pi,
			ctx,
			`Quest proposal captured: ${parsed.plan.features.length} feature(s), ${parsed.plan.milestones.length} milestone(s), ${parsed.plan.validationContract.criteria.length} validation check(s). Review with /quest, then use /quest accept.`,
		);
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
			async (snapshot) => {
				liveRun = snapshot;
				if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
					quest.activeRun.phase = snapshot.phase;
					await saveQuest(quest);
				}
				await applyQuestUi(ctx, quest);
			},
			async (pid) => {
				if (quest.activeRun?.pid === pid) return;
				if (quest.activeRun) {
					quest.activeRun.pid = pid;
					await saveQuest(quest);
				}
			},
		);
		await writeWorkerRun(quest.cwd, quest.id, run);
		quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
		liveRun = null;
		await persistLearnedWorkflows(run);
		const persistedQuest = await refreshCurrentQuest(ctx.cwd);
		if (!persistedQuest) {
			await applyQuestUi(ctx, null);
			return quest;
		}
		quest = persistedQuest;
		quest.activeRun = undefined;

		if (quest.status === "aborted") {
			await saveQuest(quest);
			await applyQuestUi(ctx, quest);
			await emitNote(pi, ctx, "Quest abort acknowledged. Use /quest resume to continue unfinished work.", "warning");
			return quest;
		}

		if (!run.ok || !revisedPlan) {
			quest.status = "paused";
			quest.lastError = run.summary;
			quest.lastSummary = "Plan revision failed. Review the quest and try again.";
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, {
				ts: Date.now(),
				type: "quest_plan_revision_failed",
				data: { summary: run.summary },
			});
			await applyQuestUi(ctx, quest);
			await emitNote(pi, ctx, `Quest replan failed. ${run.summary}`, "warning");
			return quest;
		}

		const existingPlan = quest.plan;
		if (!existingPlan) {
			quest.status = "paused";
			quest.lastError = "Quest plan disappeared before replanning could finish.";
			quest.lastSummary = "Quest replan could not continue because the current plan was missing.";
			await saveQuest(quest);
			await applyQuestUi(ctx, quest);
			return quest;
		}

		const mergedPlan = mergeRemainingPlan(existingPlan, revisedPlan);
		const hash = createHash("sha1").update(JSON.stringify(mergedPlan)).digest("hex");
		quest.plan = mergedPlan;
		quest.planHash = hash;
		quest.pendingPlanRevisionRequests = [];
		const revisionSource: "validator" | "steer" = requests.some((request) => request.source === "validator") ? "validator" : "steer";
		quest.planRevisions = [
			{
				id: randomUUID(),
				source: revisionSource,
				summary: "Revised the remaining quest plan.",
				hash,
				createdAt: Date.now(),
				requestIds: requests.map((request) => request.id),
			},
			...quest.planRevisions,
		].slice(0, 12);
		quest.lastSummary = "Revised the remaining quest plan and validation contract.";
		quest.lastError = undefined;
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, {
			ts: Date.now(),
			type: "quest_plan_revised",
			data: {
				requestCount: requests.length,
				featureCount: quest.plan.features.length,
				milestoneCount: quest.plan.milestones.length,
			},
		});
		await applyQuestUi(ctx, quest);
		await emitNote(pi, ctx, "Revised the remaining quest plan. Resuming execution.");
		return quest;
	}

	async function completeQuest(ctx: ExtensionContext, quest: QuestState) {
		quest.status = "completed";
		quest.completedAt = Date.now();
		quest.humanQaStatus = "pending";
		quest.shipReadiness = "validated_waiting_for_human_qa";
		quest.activeRun = undefined;
		quest.lastSummary = "Quest validated successfully. Human QA is still required before shipping. Use /quest approve after review.";
		quest.lastError = undefined;
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "quest_completed" });
		await applyQuestUi(ctx, quest);
		await emitNote(pi, ctx, `Quest "${quest.plan?.title ?? quest.title}" completed. Human QA is still required before shipping. Use /quest approve after review.`);
		return quest;
	}

	async function approveQuest(ctx: ExtensionContext, quest: QuestState) {
		if (quest.status !== "completed" || quest.shipReadiness !== "validated_waiting_for_human_qa") {
			await emitNote(pi, ctx, "Quest is not waiting on human QA approval.", "warning");
			return;
		}
		if (quest.humanQaStatus === "approved") {
			await emitNote(pi, ctx, `Human QA is already approved for "${quest.plan?.title ?? quest.title}".`);
			return;
		}

		quest.humanQaStatus = "approved";
		quest.shipReadiness = "human_qa_complete";
		quest.lastSummary = "Human QA approved. The quest is now marked ready to ship.";
		quest.lastError = undefined;
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, { ts: Date.now(), type: "quest_human_qa_approved" });
		await applyQuestUi(ctx, quest);
		await emitNote(pi, ctx, `Human QA approved for "${quest.plan?.title ?? quest.title}". The quest is now marked ready to ship.`);
	}

	async function runQuestMilestone(ctx: ExtensionContext, quest: QuestState): Promise<QuestState> {
		if (!quest.plan) {
			await emitNote(pi, ctx, "Quest has no approved proposal yet.", "warning");
			return quest;
		}

		if (quest.pendingPlanRevisionRequests.length > 0) {
			quest = await applyPendingPlanRevision(ctx, quest);
			if (quest.pendingPlanRevisionRequests.length > 0) return quest;
		}

		const milestone = currentMilestone(quest);
		if (!milestone) return completeQuest(ctx, quest);

		quest.status = "running";
		milestone.status = "running";
		if (!quest.startedAt) quest.startedAt = Date.now();
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, {
			ts: Date.now(),
			type: "milestone_started",
			data: { milestoneId: milestone.id, title: milestone.title },
		});
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
				async (snapshot) => {
					liveRun = snapshot;
					if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
						quest.activeRun.phase = snapshot.phase;
						await saveQuest(quest);
					}
					await applyQuestUi(ctx, quest);
				},
				async (pid) => {
					if (quest.activeRun?.pid === pid) return;
					if (quest.activeRun) {
						quest.activeRun.pid = pid;
						await saveQuest(quest);
					}
				},
			);
			liveRun = null;
			await writeWorkerRun(quest.cwd, quest.id, run);
			await persistLearnedWorkflows(run);
			const persistedQuest = await refreshCurrentQuest(ctx.cwd);
			if (!persistedQuest) {
				await applyQuestUi(ctx, null);
				return quest;
			}
			quest = persistedQuest;
			quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
			quest.activeRun = undefined;

			if (run.aborted && quest.status !== "aborted") {
				markQuestAborted(quest);
			}

			if (quest.status === "aborted") {
				await saveQuest(quest);
				await appendQuestEvent(quest.cwd, quest.id, {
					ts: Date.now(),
					type: "quest_aborted",
					data: { summary: quest.lastInterruption?.summary ?? run.summary },
				});
				await applyQuestUi(ctx, quest);
				await emitNote(pi, ctx, "Quest abort acknowledged. Use /quest resume to continue the remaining work.", "warning");
				return quest;
			}

			if (!run.ok) {
				const activeFeature = quest.plan?.features.find((item) => item.id === feature.id);
				if (activeFeature) {
					activeFeature.status = "failed";
					activeFeature.lastError = run.stderr || run.summary;
				}
				quest.status = "failed";
				quest.shipReadiness = "not_ready";
				quest.lastError = run.summary;
				quest.lastSummary = `Feature failed: ${feature.title}`;
				await saveQuest(quest);
				await appendQuestEvent(quest.cwd, quest.id, {
					ts: Date.now(),
					type: "feature_failed",
					data: { featureId: feature.id, title: feature.title, summary: run.summary },
				});
				await applyQuestUi(ctx, quest);
				await emitNote(pi, ctx, `Quest failed on feature "${feature.title}". ${run.summary}`, "error");
				return quest;
			}

			const completedFeature = quest.plan?.features.find((item) => item.id === feature.id);
			if (completedFeature) {
				completedFeature.status = "completed";
				completedFeature.lastRunSummary = run.summary;
				completedFeature.lastError = undefined;
			}
			quest.lastSummary = `Completed feature: ${feature.title}`;
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, {
				ts: Date.now(),
				type: "feature_completed",
				data: { featureId: feature.id, title: feature.title, summary: run.summary, tool: run.latestToolName },
			});
			await applyQuestUi(ctx, quest);
		}

		liveRun = createLiveRunSnapshot("validator", { milestoneId: milestone.id }, "validating");
		await persistActiveRun(ctx, quest, {
			role: "validator",
			kind: "validator",
			milestoneId: milestone.id,
			phase: liveRun.phase,
			startedAt: Date.now(),
		});

		const validator = await executeValidator(
			quest,
			milestone,
			currentMilestoneFeatures(quest, milestone.id),
			currentOrDefaultModel(quest, "validator"),
			currentWorkflows,
			async (snapshot) => {
				liveRun = snapshot;
				if (quest.activeRun && quest.activeRun.phase !== snapshot.phase) {
					quest.activeRun.phase = snapshot.phase;
					await saveQuest(quest);
				}
				await applyQuestUi(ctx, quest);
			},
			async (pid) => {
				if (quest.activeRun?.pid === pid) return;
				if (quest.activeRun) {
					quest.activeRun.pid = pid;
					await saveQuest(quest);
				}
			},
		);
		liveRun = null;
		await writeWorkerRun(quest.cwd, quest.id, validator);
		await persistLearnedWorkflows(validator);
		const persistedQuest = await refreshCurrentQuest(ctx.cwd);
		if (!persistedQuest) {
			await applyQuestUi(ctx, null);
			return quest;
		}
		quest = persistedQuest;
		quest.recentRuns = trimRecentRuns([validator, ...quest.recentRuns]);
		quest.activeRun = undefined;

		if (validator.aborted && quest.status !== "aborted") {
			markQuestAborted(quest);
		}

		if (quest.status === "aborted") {
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, {
				ts: Date.now(),
				type: "quest_aborted",
				data: { summary: quest.lastInterruption?.summary ?? validator.summary },
			});
			await applyQuestUi(ctx, quest);
			await emitNote(pi, ctx, "Quest abort acknowledged. Use /quest resume to continue the remaining work.", "warning");
			return quest;
		}

		if (!validator.ok || (validator.issues?.length ?? 0) > 0) {
			const activeMilestone = quest.plan?.milestones.find((item) => item.id === milestone.id);
			if (activeMilestone) activeMilestone.status = "blocked";
			quest.status = "paused";
			quest.shipReadiness = "not_ready";
			quest.lastError = (validator.issues && validator.issues.length > 0 ? validator.issues.join("; ") : validator.summary) || validator.summary;
			quest.lastSummary = `Validator blocked milestone "${milestone.title}".`;
			quest.pendingPlanRevisionRequests.push({
				id: randomUUID(),
				source: "validator",
				note: `Revisit remaining work after validator block on "${milestone.title}".`,
				createdAt: Date.now(),
				milestoneId: milestone.id,
				issues: validator.issues,
			});
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, {
				ts: Date.now(),
				type: "milestone_blocked",
				data: { milestoneId: milestone.id, title: milestone.title, summary: validator.summary, issues: validator.issues },
			});
			await applyQuestUi(ctx, quest);
			await emitNote(
				pi,
				ctx,
				`Milestone "${milestone.title}" is blocked. ${validator.summary} The remaining plan will be revised on the next /quest resume.`,
				"warning",
			);
			return quest;
		}

		const completedMilestone = quest.plan?.milestones.find((item) => item.id === milestone.id);
		if (completedMilestone) completedMilestone.status = "completed";
		quest.lastSummary = `Validated milestone: ${milestone.title}`;
		const remaining = quest.plan?.milestones.some((item) => item.status !== "completed") ?? false;
		quest.status = remaining ? "paused" : "completed";
		quest.shipReadiness = remaining ? "not_ready" : "validated_waiting_for_human_qa";
		if (!remaining) {
			quest.completedAt = Date.now();
			quest.humanQaStatus = "pending";
			quest.lastSummary = `Validated milestone: ${milestone.title}. Human QA is still required before shipping. Use /quest approve after review.`;
		}
		await saveQuest(quest);
		await appendQuestEvent(quest.cwd, quest.id, {
			ts: Date.now(),
			type: "milestone_completed",
			data: { milestoneId: milestone.id, title: milestone.title, summary: validator.summary },
		});
		await applyQuestUi(ctx, quest);
			await emitNote(
				pi,
				ctx,
				remaining
					? `Milestone "${milestone.title}" completed. Use /quest resume for the next milestone.`
					: `Quest "${quest.plan?.title ?? quest.title}" validated. Human QA is still required before shipping. Use /quest approve after review.`,
			);
		return quest;
	}

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _context, theme) => {
		return new Text(theme.fg("accent", "[quest] ") + String(message.content), 0, 0);
	});

	const handleQuestCommand = async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);

		if (!trimmed) {
			await showStatus(ctx);
			return;
		}

		const [subcommand, ...rest] = trimmed.split(/\s+/);
		const remainder = rest.join(" ").trim();

		switch (subcommand) {
			case "new": {
				if (!remainder) {
					await emitNote(pi, ctx, "Usage: /quest new <goal>", "warning");
					return;
				}
				if (currentQuest && !questIsTerminal(currentQuest)) {
					await emitNote(pi, ctx, "There is already an active non-terminal quest in this repo. Use /quest to inspect it or /quests to switch quests.", "warning");
					return;
				}
				currentQuest = await createPlanningQuest(ctx, remainder, { triggerPlanningTurn: ctx.hasUI });
				if (ctx.hasUI) await setQuestMode(ctx, true);
				await emitNote(pi, ctx, `Quest created: ${remainder}`);
				if (!ctx.hasUI) {
					await emitNote(pi, ctx, "Quest created safely in non-interactive mode. Run another prompt in this repo to continue planning.");
					return;
				}
				planningTurnActive = true;
				const prompt = questPlanningPrompt(remainder);
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
				return;
			}

			case "accept": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest. Use /enter-quest or /quest new <goal> to create one.", "warning");
					return;
				}
				if (currentQuest.status === "running" || currentQuest.activeRun) {
					await emitNote(pi, ctx, "Quest is already running. Use /quest abort if you need to interrupt the active run.", "warning");
					return;
				}
				if (!currentQuest.plan || currentQuest.status !== "ready") {
					await emitNote(pi, ctx, "Use /quest accept only after the quest proposal reaches ready.", "warning");
					return;
				}
				currentQuest = await runQuestMilestone(ctx, currentQuest);
				return;
			}

			case "resume": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest. Use /enter-quest or /quest new <goal> to create one.", "warning");
					return;
				}
				if (currentQuest.status === "running" || currentQuest.activeRun) {
					await emitNote(pi, ctx, "Quest is already running. Use /quest abort if you need to interrupt the active run.", "warning");
					return;
				}
				if (!currentQuest.plan) {
					await emitNote(pi, ctx, "Quest has no approved proposal yet. Keep planning until the quest proposal reaches ready.", "warning");
					return;
				}
				if (currentQuest.status === "completed") {
					await emitNote(
						pi,
						ctx,
						questAwaitingHumanQa(currentQuest)
							? "Quest is already validated. Human QA is still required before shipping. Use /quest approve after review."
							: "Quest is already completed and human QA has already been approved.",
					);
					return;
				}
				if (currentQuest.status !== "paused" && currentQuest.status !== "aborted") {
					await emitNote(pi, ctx, "Use /quest resume only for paused or aborted quests.", "warning");
					return;
				}

				if (currentQuest.status === "aborted") {
					if (prepareQuestForResume(currentQuest)) {
						await appendQuestEvent(ctx.cwd, currentQuest.id, {
							ts: Date.now(),
							type: "quest_resumed_after_abort",
							data: {
								summary: currentQuest.lastInterruption?.summary,
							},
						});
					}
				}

				currentQuest = await runQuestMilestone(ctx, currentQuest);
				return;
			}

			case "approve": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest to approve.", "warning");
					return;
				}
				await approveQuest(ctx, currentQuest);
				return;
			}

			case "pause": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest to pause.", "warning");
					return;
				}
				if (currentQuest.status === "running" || currentQuest.activeRun) {
					await emitNote(pi, ctx, "Quest is actively running. Use /quest abort to stop the active worker, validator, or replan run.", "warning");
					return;
				}
				if (currentQuest.status === "planning") {
					await emitNote(pi, ctx, "Quest planning is conversational. Use /exit-quest to leave quest mode or keep refining the proposal.", "warning");
					return;
				}
				currentQuest.status = "paused";
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, { ts: Date.now(), type: "quest_paused" });
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, "Quest paused.");
				return;
			}

			case "abort": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest to abort.", "warning");
					return;
				}
				if (!currentQuest.activeRun) {
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
					data: {
						summary,
						pid: activePid,
						termination: terminationSummary,
					},
				});
				await appendQuestEvent(ctx.cwd, currentQuest.id, {
					ts: Date.now(),
					type: "quest_aborted",
					data: {
						summary: currentQuest.lastInterruption?.summary ?? summary,
					},
				});
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, `${summary ?? "Quest abort requested."} ${terminationSummary}`.trim(), "warning");
				return;
			}

			case "steer": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest to steer.", "warning");
					return;
				}
				if (!remainder) {
					await emitNote(pi, ctx, "Usage: /quest steer <instruction>", "warning");
					return;
				}
				currentQuest = await queueSteeringNote(ctx, currentQuest, remainder, "command");
				return;
			}

			case "model": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest.", "warning");
					return;
				}
				const next = await chooseModelChoice(pi, ctx, currentQuest.defaultModel, currentQuest.status === "planning");
				if (!next) return;
				currentQuest.defaultModel = next;
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, {
					ts: Date.now(),
					type: "quest_default_model_changed",
					data: { model: `${next.provider}/${next.model}`, thinkingLevel: next.thinkingLevel },
				});
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, `Quest default model set to ${modelLabel(next)}.`);
				return;
			}

			case "role-model": {
				if (!currentQuest) {
					await emitNote(pi, ctx, "No active quest.", "warning");
					return;
				}
				const role = roleFromArg(remainder);
				if (!role) {
					await emitNote(pi, ctx, "Usage: /quest role-model <orchestrator|worker|validator>", "warning");
					return;
				}
				const next = await chooseModelChoice(
					pi,
					ctx,
					currentQuest.roleModels[role] ?? currentQuest.defaultModel,
					role === "orchestrator" && currentQuest.status === "planning",
				);
				if (!next) return;
				currentQuest.roleModels[role] = next;
				await saveQuest(currentQuest);
				await appendQuestEvent(ctx.cwd, currentQuest.id, {
					ts: Date.now(),
					type: "quest_role_model_changed",
					data: { role, model: `${next.provider}/${next.model}`, thinkingLevel: next.thinkingLevel },
				});
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, `${role} model set to ${modelLabel(next)}.`);
				return;
			}

			case "prune": {
				const result = await pruneQuestStorage();
				await emitNote(
					pi,
					ctx,
					`Pruned quest runtime logs: ${result.prunedLogs} event log(s), ${result.deletedRuns} worker run file(s). Quest metadata, validation contracts, and learned workflows were kept.`,
				);
				return;
			}

			default: {
				if (subcommand === "status") {
					await emitNote(pi, ctx, "Use /quest to open Quest Control.", "warning");
					return;
				}
				if (subcommand === "start") {
					await emitNote(pi, ctx, "Use /quest accept to approve a ready quest proposal.", "warning");
					return;
				}
				await emitNote(
					pi,
					ctx,
					"Unknown /quest subcommand. Use /quest, /quest new <goal>, /quest accept, /quest resume, /quest abort, /quest approve, /quest model, /quest role-model <role>, or /quest prune.",
					"warning",
				);
			}
		}
	};

	pi.registerCommand("enter-quest", {
		description: "Enter quest mode for conversational planning and steering",
		handler: async (_args, ctx) => {
			currentQuest = await loadActiveQuest(ctx.cwd);
			currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
			await setQuestMode(ctx, true);
			if (!currentQuest) {
				await emitNote(pi, ctx, "Quest mode enabled. Type the goal in plain text to create a new quest.");
				return;
			}
			if (currentQuest.status === "planning") {
				await emitNote(pi, ctx, "Quest mode enabled. Continue planning in plain text.");
				return;
			}
			if (currentQuest.status === "ready") {
				await emitNote(pi, ctx, "Quest mode enabled. Plain text will queue revisions for the remaining plan. Use /quest accept when the proposal is ready.");
				return;
			}
			if (currentQuest.status === "running") {
				await emitNote(pi, ctx, "Quest mode enabled. Plain text will queue steering notes for the remaining plan. Use /quest abort for immediate interruption.");
				return;
			}
			if (currentQuest.status === "completed") {
				await emitNote(pi, ctx, "Quest mode enabled. Completed quests are not reopened by plain text. Use /quest new <goal> to create a new quest.");
				return;
			}
			await emitNote(pi, ctx, "Quest mode enabled. Plain text will revise the remaining plan for the active quest.");
		},
	});

	pi.registerCommand("exit-quest", {
		description: "Exit quest mode and restore normal Pi input handling",
		handler: async (_args, ctx) => {
			await setQuestMode(ctx, false);
			await emitNote(pi, ctx, "Quest mode disabled.");
		},
	});

	pi.registerCommand("quest", {
		description: "Open Quest Control or operate on the active quest",
		getArgumentCompletions: (prefix) => {
			const options = ["new", "accept", "resume", "approve", "pause", "abort", "steer", "model", "role-model", "prune"];
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
		questModeEnabled = questModeEntry?.data?.enabled === true;
		planningTurnActive = false;
		await pruneQuestStorage();
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
			currentQuest = await createPlanningQuest(ctx, trimmed, { triggerPlanningTurn: true });
			await emitNote(pi, ctx, `Quest created: ${trimmed}`);
			planningTurnActive = true;
			return { action: "transform" as const, text: questPlanningPrompt(trimmed) };
		}

		if (currentQuest.status === "planning") {
			planningTurnActive = true;
			await applyQuestUi(ctx, currentQuest);
			return { action: "continue" as const };
		}

		if (currentQuest.status === "ready" || currentQuest.status === "paused" || currentQuest.status === "aborted" || currentQuest.status === "running") {
			currentQuest = await queueSteeringNote(ctx, currentQuest, trimmed, "quest-mode");
			return { action: "handled" as const };
		}

		if (currentQuest.status === "completed") {
			await emitNote(pi, ctx, "Active quest is already completed. Use /quest new <goal> to create a new quest.", "warning");
			return { action: "handled" as const };
		}

		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		const planningAllowed = planningTurnActive || !ctx.hasUI;
		if (!planningAllowed || !currentQuest || currentQuest.status !== "planning") return;
		planningEvents = [];
		liveRun = createLiveRunSnapshot("orchestrator", {}, "planning");
		await applyQuestUi(ctx, currentQuest);
		return {
			message: {
				customType: "pi-quest-planning",
				content: planningInstructions(currentQuest, currentWorkflows),
				display: false,
			},
		};
	});

	const planningRuntimeEvent = async (event: any, ctx: ExtensionContext) => {
		if (!planningTurnActive && ctx.hasUI) return;
		currentQuest = await loadActiveQuest(ctx.cwd);
		if (!currentQuest || currentQuest.status !== "planning") return;
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
		if (!planningAllowed || !currentQuest || currentQuest.status !== "planning") {
			planningTurnActive = false;
			return;
		}
		const next = applyAgentEventToSnapshot(liveRun ?? createLiveRunSnapshot("orchestrator", {}), event, 60, planningEvents);
		liveRun = next.snapshot;
		planningEvents = next.events;
		const text = latestAssistantText(event.messages as any[]);
		if (!text) {
			liveRun = null;
			planningTurnActive = false;
			await applyQuestUi(ctx, currentQuest);
			return;
		}
		await markPlanReady(ctx, currentQuest, text);
		planningTurnActive = false;
	});
}
