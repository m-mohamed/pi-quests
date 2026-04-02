import { createHash, randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { mergeRemainingPlan, parseQuestPlanText, planningInstructions } from "./plan-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import {
	appendQuestEvent,
	createQuest,
	loadActiveQuest,
	loadLearnedWorkflows,
	questIsTerminal,
	pruneQuestStorage,
	saveLearnedWorkflows,
	saveQuest,
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
	ModelChoice,
	ThinkingLevel,
	WorkerEventRecord,
} from "./types.js";

const CUSTOM_MESSAGE_TYPE = "pi-quests";
const STATUS_KEY = "pi-quests";
const WIDGET_KEY = "pi-quests";
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

function summarizeQuest(quest: QuestState, workflows: LearnedWorkflow[], liveRun: LiveRunSnapshot | null): string {
	const featureCount = quest.plan?.features.length ?? 0;
	const done = quest.plan?.features.filter((feature) => feature.status === "completed").length ?? 0;
	const milestone = currentMilestone(quest);
	const weakWarnings = quest.plan?.validationContract.weakValidationWarnings.length ?? 0;

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
- Next action: ${questAwaitingHumanQa(quest) ? "/quest approve" : quest.status === "ready" ? "/quest start" : quest.status === "paused" ? "/quest resume" : "none"}
- Active run: ${liveRun ? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` · ${liveRun.latestToolName}` : ""}${liveRun.latestMessage ? ` · ${truncate(liveRun.latestMessage, 80)}` : ""}` : "idle"}
${quest.lastSummary ? `- Last summary: ${quest.lastSummary}` : ""}
${quest.lastError ? `- Last error: ${quest.lastError}` : ""}

Recent runs:
${summarizeRecentRuns(quest)}

${quest.plan?.validationContract.weakValidationWarnings.length ? `Validation warnings:\n${quest.plan.validationContract.weakValidationWarnings.map((warning) => `- ${warning}`).join("\n")}` : "Validation warnings:\n- none"}

${quest.pendingPlanRevisionRequests.length ? `Pending revision requests:\n${quest.pendingPlanRevisionRequests.map((request) => `- [${request.source}] ${request.note}`).join("\n")}` : "Pending revision requests:\n- none"}`;
}

function questWidgetLines(quest: QuestState, workflows: LearnedWorkflow[], liveRun: LiveRunSnapshot | null): string[] {
	const lines = [`quest:${quest.plan?.title ?? quest.title} [${quest.status}]`, `default:${modelLabel(quest.defaultModel)}`];
	const milestone = currentMilestone(quest);
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

	async function applyQuestUi(ctx: ExtensionContext, quest: QuestState | null) {
		if (!ctx.hasUI) return;
		if (!quest) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const liveSummary = liveRun ? ` · ${liveRun.role}:${liveRun.phase}` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `quest:${quest.status}${liveSummary}`));
		ctx.ui.setWidget(WIDGET_KEY, questWidgetLines(quest, currentWorkflows, liveRun));
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
			await emitNote(pi, ctx, "No active quest for this repo. Start one with /quest <goal>.");
			await applyQuestUi(ctx, null);
			return;
		}
		await emitNote(pi, ctx, summarizeQuest(currentQuest, currentWorkflows, liveRun));
		await applyQuestUi(ctx, currentQuest);
	}

	async function markPlanReady(ctx: ExtensionContext, quest: QuestState, text: string) {
		const parsed = parseQuestPlanText(text);
		if (!parsed) return;
		if (quest.planHash === parsed.hash) return;

		quest.plan = parsed.plan;
		quest.planHash = parsed.hash;
		quest.title = parsed.plan.title;
		quest.status = "ready";
		quest.lastSummary = `${parsed.plan.summary} Review the proposal and validation contract, then use /quest start.`;
		quest.lastError = undefined;
		quest.pendingPlanRevisionRequests = [];
		quest.planRevisions = [
			{
				id: randomUUID(),
				source: "initial",
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
			`Quest proposal captured: ${parsed.plan.features.length} feature(s), ${parsed.plan.milestones.length} milestone(s), ${parsed.plan.validationContract.criteria.length} validation check(s). Review with /quest status, then use /quest start.`,
		);
	}

	async function applyPendingPlanRevision(ctx: ExtensionContext, quest: QuestState): Promise<QuestState> {
		if (!quest.plan || quest.pendingPlanRevisionRequests.length === 0) return quest;

		const requests = [...quest.pendingPlanRevisionRequests];
		liveRun = createLiveRunSnapshot("orchestrator", { milestoneId: currentMilestone(quest)?.id }, "replanning");
		await applyQuestUi(ctx, quest);

		const { run, revisedPlan } = await executePlanRevision(
			quest,
			requests,
			currentOrDefaultModel(quest, "orchestrator"),
			currentWorkflows,
			async (snapshot) => {
				liveRun = snapshot;
				await applyQuestUi(ctx, quest);
			},
		);
		await writeWorkerRun(quest.cwd, quest.id, run);
		quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
		liveRun = null;
		await persistLearnedWorkflows(run);

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

		const mergedPlan = mergeRemainingPlan(quest.plan, revisedPlan);
		const hash = createHash("sha1").update(JSON.stringify(mergedPlan)).digest("hex");
		quest.plan = mergedPlan;
		quest.planHash = hash;
		quest.pendingPlanRevisionRequests = [];
		quest.planRevisions = [
			{
				id: randomUUID(),
				source: requests.some((request) => request.source === "validator") ? "validator" : "steer",
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
		if (quest.humanQaStatus === "approved" || quest.shipReadiness === "human_qa_complete") {
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
			await saveQuest(quest);
			liveRun = createLiveRunSnapshot("worker", { featureId: feature.id, milestoneId: milestone.id });
			await applyQuestUi(ctx, quest);

			const run = await executeFeatureWorker(
				quest,
				feature,
				milestone,
				currentOrDefaultModel(quest, "worker"),
				currentWorkflows,
				async (snapshot) => {
					liveRun = snapshot;
					await applyQuestUi(ctx, quest);
				},
			);
			liveRun = null;
			await writeWorkerRun(quest.cwd, quest.id, run);
			quest.recentRuns = trimRecentRuns([run, ...quest.recentRuns]);
			await persistLearnedWorkflows(run);

			if (!run.ok) {
				feature.status = "failed";
				feature.lastError = run.stderr || run.summary;
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

			feature.status = "completed";
			feature.lastRunSummary = run.summary;
			feature.lastError = undefined;
			quest.lastSummary = `Completed feature: ${feature.title}`;
			await saveQuest(quest);
			await appendQuestEvent(quest.cwd, quest.id, {
				ts: Date.now(),
				type: "feature_completed",
				data: { featureId: feature.id, title: feature.title, summary: run.summary, tool: run.latestToolName },
			});
			await applyQuestUi(ctx, quest);
		}

		const milestoneFeatures = currentMilestoneFeatures(quest, milestone.id);
		liveRun = createLiveRunSnapshot("validator", { milestoneId: milestone.id }, "validating");
		await applyQuestUi(ctx, quest);

		const validator = await executeValidator(
			quest,
			milestone,
			milestoneFeatures,
			currentOrDefaultModel(quest, "validator"),
			currentWorkflows,
			async (snapshot) => {
				liveRun = snapshot;
				await applyQuestUi(ctx, quest);
			},
		);
		liveRun = null;
		await writeWorkerRun(quest.cwd, quest.id, validator);
		quest.recentRuns = trimRecentRuns([validator, ...quest.recentRuns]);
		await persistLearnedWorkflows(validator);

		if (!validator.ok || (validator.issues?.length ?? 0) > 0) {
			milestone.status = "blocked";
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

		milestone.status = "completed";
		quest.lastSummary = `Validated milestone: ${milestone.title}`;
		const remaining = quest.plan.milestones.some((item) => item.status !== "completed");
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
					: `Quest "${quest.plan.title}" validated. Human QA is still required before shipping. Use /quest approve after review.`,
			);
		return quest;
	}

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _context, theme) => {
		return new Text(theme.fg("accent", "[quest] ") + String(message.content), 0, 0);
	});

	const handleQuestCommand = async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await showStatus(ctx);
				return;
			}

			const [subcommand, ...rest] = trimmed.split(/\s+/);
			const remainder = rest.join(" ").trim();
			currentQuest = await loadActiveQuest(ctx.cwd);
			currentWorkflows = await loadLearnedWorkflows(ctx.cwd);

			switch (subcommand) {
				case "status":
					await showStatus(ctx);
					return;

				case "approve": {
					if (!currentQuest) {
						await emitNote(pi, ctx, "No active quest to approve.", "warning");
						return;
					}
					await approveQuest(ctx, currentQuest);
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

				case "pause": {
					if (!currentQuest) {
						await emitNote(pi, ctx, "No active quest to pause.", "warning");
						return;
					}
					currentQuest.status = "paused";
					await saveQuest(currentQuest);
					await appendQuestEvent(ctx.cwd, currentQuest.id, { ts: Date.now(), type: "quest_paused" });
					await applyQuestUi(ctx, currentQuest);
					await emitNote(pi, ctx, "Quest paused.");
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

					currentQuest.steeringNotes.push(remainder);
					if (currentQuest.status !== "planning" && currentQuest.plan && currentQuest.status !== "completed") {
						currentQuest.pendingPlanRevisionRequests.push({
							id: randomUUID(),
							source: "steer",
							note: remainder,
							createdAt: Date.now(),
						});
						currentQuest.status = "paused";
						currentQuest.lastSummary = "Steering note saved. The remaining plan will be revised on the next /quest resume.";
					}

					await saveQuest(currentQuest);
					await appendQuestEvent(ctx.cwd, currentQuest.id, {
						ts: Date.now(),
						type: "quest_steer",
						data: { note: remainder },
					});

					if (currentQuest.status === "planning") {
						if (ctx.isIdle()) {
							pi.sendUserMessage(`Quest steer: ${remainder}`);
						} else {
							pi.sendUserMessage(`Quest steer: ${remainder}`, { deliverAs: "followUp" });
						}
						await emitNote(pi, ctx, "Steering note sent to the planning session.");
					} else if (currentQuest.status === "completed") {
						await emitNote(pi, ctx, "Quest is already completed. Steering note was saved, but there is no remaining plan to revise.", "warning");
					} else {
						await emitNote(pi, ctx, "Steering note saved. The remaining plan will be revised on the next /quest resume.");
					}

					await applyQuestUi(ctx, currentQuest);
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

				case "start":
				case "resume": {
					if (!currentQuest) {
						await emitNote(pi, ctx, "No active quest. Start planning with /quest <goal>.", "warning");
						return;
					}
					if (!currentQuest.plan) {
						await emitNote(pi, ctx, "Quest has no approved proposal yet. Keep planning until Pi emits the JSON quest proposal.", "warning");
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
					currentQuest = await runQuestMilestone(ctx, currentQuest);
					return;
				}

				default: {
					const existing = currentQuest;
					if (existing && !questIsTerminal(existing) && existing.status !== "planning" && existing.status !== "ready" && existing.status !== "paused") {
						await emitNote(pi, ctx, "There is already an active quest in progress. Use /quest status or /quest pause before starting a new one.", "warning");
						return;
					}
					const modelChoice = createDefaultModelChoice(ctx.model ?? null, pi.getThinkingLevel() as ThinkingLevel);
					currentQuest = await createQuest(ctx.cwd, trimmed, modelChoice);
					currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
					await pruneQuestStorage();
					await applyQuestUi(ctx, currentQuest);
					await emitNote(pi, ctx, `Quest created: ${trimmed}`);
					const prompt = `Let's plan a quest for this repository.\n\nGoal: ${trimmed}\n\nAsk clarifying questions if needed. When the proposal is ready, return the quest JSON in the required schema.`;
					if (ctx.isIdle()) {
						pi.sendUserMessage(prompt);
					} else {
						pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					}
				}
			}
	};

	pi.registerCommand("quest", {
		description: "Manage private Pi quests",
		getArgumentCompletions: (prefix) => {
			const options = ["start", "resume", "approve", "status", "pause", "steer", "model", "role-model", "prune"];
			return options.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
		},
		handler: handleQuestCommand,
	});

	pi.registerCommand("quests", {
		description: "Alias for /quest",
		handler: handleQuestCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		await pruneQuestStorage();
		await loadQuestForContext(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentQuest = await loadActiveQuest(ctx.cwd);
		currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
		if (!currentQuest || currentQuest.status !== "planning") return;
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
		if (!currentQuest || currentQuest.status !== "planning") return;
		const next = applyAgentEventToSnapshot(liveRun ?? createLiveRunSnapshot("orchestrator", {}), event, 60, planningEvents);
		liveRun = next.snapshot;
		planningEvents = next.events;
		const text = latestAssistantText(event.messages as any[]);
		if (!text) {
			liveRun = null;
			await applyQuestUi(ctx, currentQuest);
			return;
		}
		await markPlanReady(ctx, currentQuest, text);
	});
}
