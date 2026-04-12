import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import {
	getMarkdownTheme,
	isBashToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Key, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
	type ControlPanelAction,
	type ControlPanelItem,
	type ControlPanelOutcome,
	openControlPanel,
} from "./control-panel.js";
import {
	buildQuestShellEnvironment,
	discoverQuestSkillPaths,
	prefixQuestShellCommand,
	protectedQuestArtifactReason,
	questToolResultGuidance,
} from "./extension-core.js";
import { internalModeEnabled } from "./internal-mode.js";
import { traceBundleFromPlanningSession, traceBundleFromWorkerRun } from "./profile-core.js";
import { mergeRemainingPlan, parseQuestPlanText, planningInstructions } from "./plan-core.js";
import {
	loadFrontierTrials,
	loadInternalUi,
	loadRuntimeProfile,
	type FrontierTrialsModule,
	type InternalUiModule,
} from "./quest-internal-loader.js";
import {
	activeProfileFor,
	appendCorrectiveFeatures,
	createDefaultModelChoice,
	currentMilestone,
	currentMilestoneFeatures,
	currentOrDefaultModel,
	humanQaChecklist,
	markAssertions,
	modelLabel,
	nextPendingFeature,
	proposalReady,
	readinessSummaryForWarnings,
	relevantAssertionsForPass,
	roleFromArg,
	summarizeQuest,
	syncQuestConfig,
	synthesizeAssertionsForQuestPlan,
} from "./quest-runtime-helpers.js";
import { applyQuestUi as renderQuestUi, summarizeTrials } from "./quest-ui-controller.js";
import { registerQuestTools } from "./quest-tools.js";
import { describeActiveRun, markQuestAborted, prepareQuestForResume, terminateQuestProcess } from "./runtime-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import { truncate } from "./utils.js";
import { buildQuestControlItems } from "./ui-core.js";
import {
	appendQuestEvent,
	createQuest,
	listProjectQuests,
	loadActiveQuest,
	loadLearnedWorkflows,
	loadQuestTrialState,
	loadQuest,
	pruneQuestStorage,
	saveQuestTrialState,
	saveQuestProfile,
	saveLearnedWorkflows,
	saveQuest,
	switchActiveQuest,
	trimRecentRuns,
	writeQuestTraceBundle,
	writeWorkerRun,
} from "./state-core.js";
import { executeFeatureWorker, executePlanRevision, executeValidationReadinessProbe, executeValidator } from "./workers.js";
import { deriveLearnedWorkflows, mergeLearnedWorkflows } from "./workflows.js";
import type {
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
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
	WorkerEventRecord,
} from "./types.js";

const CUSTOM_MESSAGE_TYPE = "pi-quests";
const STATUS_KEY = "pi-quests";
const WIDGET_KEY = "pi-quests";
const QUEST_MODE_ENTRY = "quest-mode";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
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

export default function questExtension(pi: ExtensionAPI) {
	let currentQuest: QuestState | null = null;
	let currentWorkflows: LearnedWorkflow[] = [];
	let currentProfile: QuestProfile | null = null;
	let currentTrialState: QuestTrialState | null = null;
	let liveRun: LiveRunSnapshot | null = null;
	let trialLiveRun: LiveRunSnapshot | null = null;
	let lastContextUsage: ContextUsage | null = null;
	let planningEvents: WorkerEventRecord[] = [];
	let planningStartedAt = 0;
	let questModeEnabled = false;
	let planningTurnActive = false;
	let activeTrialPid: number | undefined;
	let pendingQuestControlOpen = false;

	function persistQuestMode() {
		pi.appendEntry(QUEST_MODE_ENTRY, { enabled: questModeEnabled });
	}

	async function applyQuestUi(ctx: ExtensionContext, quest: QuestState | null) {
		await renderQuestUi(ctx, quest, {
			statusKey: STATUS_KEY,
			widgetKey: WIDGET_KEY,
			questModeEnabled,
			lastContextUsage,
			currentTrialState,
			liveRun,
			trialLiveRun,
			loadInternalUi,
		});
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
		const runtimeProfile = await loadRuntimeProfile(ctx.cwd);
		currentTrialState = runtimeProfile.trialState;
		currentProfile = runtimeProfile.profile;
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
		const runtimeProfile = await loadRuntimeProfile(ctx.cwd);
		currentTrialState = runtimeProfile.trialState;
		currentProfile = runtimeProfile.profile;
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
		const runtimeProfile = await loadRuntimeProfile(ctx.cwd, { ensure: internalModeEnabled() });
		currentTrialState = runtimeProfile.trialState;
		currentProfile = runtimeProfile.profile;
		if (internalModeEnabled()) await saveQuestProfile(ctx.cwd, currentProfile);
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

		let selectedValue: string | null = null;
		while (true) {
			currentQuest = (await loadActiveQuest(ctx.cwd)) ?? quest;
			currentWorkflows = await loadLearnedWorkflows(ctx.cwd);
			const questForView = currentQuest;
			const actions: ControlPanelAction<"accept" | "resume" | "pause" | "abort" | "refresh">[] = [
				{ key: "g", label: "refresh", result: "refresh" },
			];
			if (questForView.status === "proposal_ready") actions.unshift({ key: "r", label: "accept", result: "accept" });
			if (questForView.status === "paused" || questForView.status === "blocked") actions.unshift({ key: "r", label: "resume", result: "resume" });
			if (questForView.status === "running") actions.unshift({ key: "p", label: "pause", result: "pause" });
			if (questForView.status !== "completed" && questForView.status !== "aborted") actions.push({ key: "a", label: "abort", result: "abort" });
			const outcome: ControlPanelOutcome<"accept" | "resume" | "pause" | "abort" | "refresh"> | null = await openControlPanel(ctx, {
				title: `Quest Control · ${questForView.plan?.title ?? questForView.title}`,
				subtitle: `${questForView.status} · ${questForView.goal}`,
				items: buildQuestControlItems(questForView, liveRun),
				selectedValue,
				actions,
			});
			if (!outcome || outcome.action === "close") return;
			selectedValue = outcome.selectedValue;
			if (outcome.action === "refresh") continue;
			await handleQuestCommand(outcome.action, ctx);
		}
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

	async function openQuestTrialsControl(ctx: ExtensionContext) {
		if (!internalModeEnabled()) {
			await emitNote(pi, ctx, "Quest Trials is maintainer-only and not part of the public package surface.", "warning");
			return;
		}
		let trials: FrontierTrialsModule;
		try {
			trials = await loadFrontierTrials();
		} catch (error) {
			await emitNote(pi, ctx, error instanceof Error ? error.message : String(error), "warning");
			return;
		}
		const status = await trials.collectFrontierTrialStatus(ctx.cwd);
		const summary = trials.summarizeTrialStatus(status);
		currentTrialState = status.state;
		currentProfile = status.profile;
		if (status.state.status !== "running") {
			activeTrialPid = undefined;
			trialLiveRun = null;
		}
		if (!ctx.hasUI || !ctx.ui.custom) {
			await emitNote(pi, ctx, summarizeTrials(summary, trialLiveRun));
			return;
		}

		let selectedValue: string | null = null;
		while (true) {
			const nextStatus = await trials.collectFrontierTrialStatus(ctx.cwd);
			currentTrialState = nextStatus.state;
			currentProfile = nextStatus.profile;
			if (nextStatus.state.status !== "running") {
				activeTrialPid = undefined;
				trialLiveRun = null;
			}
			let internalUi: InternalUiModule;
			try {
				internalUi = await loadInternalUi();
			} catch (error) {
				await emitNote(pi, ctx, error instanceof Error ? error.message : String(error), "warning");
				return;
			}
			const actions: ControlPanelAction<"baseline" | "run" | "stop" | "profile" | "refresh">[] =
				nextStatus.state.status === "running"
					? [
							{ key: "s", label: "stop", result: "stop" },
							{ key: "p", label: "profile", result: "profile" },
							{ key: "g", label: "refresh", result: "refresh" },
						]
					: [
							{ key: "b", label: "baseline", result: "baseline" },
							{ key: "r", label: "run", result: "run" },
							{ key: "p", label: "profile", result: "profile" },
							{ key: "g", label: "refresh", result: "refresh" },
						];
			const outcome: ControlPanelOutcome<"baseline" | "run" | "stop" | "profile" | "refresh"> | null = await openControlPanel(ctx, {
				title: "Quest Trials",
				subtitle: `${nextStatus.state.status} · ${nextStatus.profile.id}`,
				items: internalUi.buildTrialsControlItems(nextStatus.state, nextStatus.profile.id, trialLiveRun),
				selectedValue,
				actions,
			});
			if (!outcome || outcome.action === "close") return;
			selectedValue = outcome.selectedValue;
			if (outcome.action === "refresh") continue;
			await handleQuestTrialsCommand(outcome.action, ctx);
		}
	}

	async function handleQuestTrialsCommand(args: string, ctx: ExtensionContext) {
		if (!internalModeEnabled()) {
			await emitNote(pi, ctx, "Quest Trials is maintainer-only and not part of the public package surface.", "warning");
			return;
		}
		let trials: FrontierTrialsModule;
		try {
			trials = await loadFrontierTrials();
		} catch (error) {
			await emitNote(pi, ctx, error instanceof Error ? error.message : String(error), "warning");
			return;
		}
		const trimmed = args.trim();
		const readFlag = (flag: string): string | undefined => {
			const parts = trimmed.split(/\s+/);
			const index = parts.indexOf(flag);
			return index >= 0 ? parts[index + 1] : undefined;
		};
		const hasFlag = (flag: string): boolean => trimmed.split(/\s+/).includes(flag);
		const status = await trials.collectFrontierTrialStatus(ctx.cwd);
		currentTrialState = status.state;
		currentProfile = status.profile;
		if (status.state.status !== "running") {
			activeTrialPid = undefined;
			trialLiveRun = null;
		}

		if (!trimmed) {
			await emitNote(pi, ctx, trials.summarizeTrialStatus(status));
			return;
		}

		const [subcommand, ...rest] = trimmed.split(/\s+/);
		const remainder = rest.join(" ").trim();
		const requestedBenchmark = readFlag("--benchmark");
		if (requestedBenchmark && requestedBenchmark !== "terminal-bench" && requestedBenchmark !== "slopcodebench") {
			await emitNote(pi, ctx, "Unsupported benchmark family. Use --benchmark terminal-bench or --benchmark slopcodebench.", "warning");
			return;
		}
		const benchmark = requestedBenchmark as "terminal-bench" | "slopcodebench" | undefined;
		const dataset = readFlag("--dataset") ?? (remainder && !remainder.startsWith("--") ? remainder : undefined);
		const repo = readFlag("--repo");

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
				const iterations = Number(readFlag("--iterations") ?? "1");
				try {
					const result = await trials.runTrialOptimization(
						ctx.cwd,
						modelChoice,
						{
							benchmark,
							dataset,
							repo,
							force: hasFlag("--force"),
							iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : 1,
							onSnapshot: async (snapshotUpdate) => {
								trialLiveRun = snapshotUpdate;
								await applyQuestUi(ctx, currentQuest);
							},
							onProcessStart: async (pid) => {
								activeTrialPid = pid;
							},
						},
					);
					currentTrialState = result.state;
					currentProfile = result.profile;
					await emitNote(pi, ctx, result.summary);
					return;
				} finally {
					activeTrialPid = undefined;
					trialLiveRun = null;
					const nextStatus = await trials.collectFrontierTrialStatus(ctx.cwd);
					currentTrialState = nextStatus.state;
					currentProfile = nextStatus.profile;
					await applyQuestUi(ctx, currentQuest);
				}
			}

			case "stop": {
				const persistedState = await loadQuestTrialState(ctx.cwd, { ensure: true });
				const activePid = persistedState.activeRun?.pid ?? activeTrialPid;
				if (typeof activePid === "number") {
					await terminateQuestProcess(activePid);
				}
				activeTrialPid = undefined;
				trialLiveRun = null;
				persistedState.activeRun = undefined;
				persistedState.status = "stopped";
				persistedState.lastSummary = "Trials stopped by operator.";
				await saveQuestTrialState(ctx.cwd, persistedState);
				currentTrialState = persistedState;
				await applyQuestUi(ctx, currentQuest);
				await emitNote(pi, ctx, "Trials stopped.", "warning");
				return;
			}

			case "prepare-benchmark": {
				const prepared = await trials.prepareTrialBenchmark(ctx.cwd, { benchmark, dataset, repo, force: hasFlag("--force") });
				currentTrialState = prepared.state;
				await emitNote(
					pi,
					ctx,
					`Prepared ${prepared.manifest.family}:${prepared.manifest.dataset}: ${prepared.searchSet.totalItems} search / ${prepared.holdOutSet.totalItems} hold-out items.\nNext: /quest trials baseline${benchmark ? ` --benchmark ${benchmark}` : ""}${dataset ? ` --dataset ${dataset}` : ""}${repo ? ` --repo ${repo}` : ""}`,
				);
				return;
			}

			case "analyze-community": {
				const stats = await trials.analyzeTrialCommunity(ctx.cwd, hasFlag("--force"));
				await emitNote(
					pi,
					ctx,
					`Analyzed community traces: ${stats.parsedSessions}/${stats.totalSessions} valid Pi sessions across ${Object.keys(stats.sources).length} source(s).`,
				);
				return;
			}

			case "baseline": {
				if (currentTrialState.status === "running") {
					await emitNote(pi, ctx, "Trials are already running.", "warning");
					return;
				}
				const modelChoice =
					currentQuest && currentQuest.status !== "completed" && currentQuest.status !== "aborted"
						? currentOrDefaultModel(currentQuest, "orchestrator")
						: createDefaultModelChoice(ctx.model ?? null, pi.getThinkingLevel() as ThinkingLevel);
				try {
					const result = await trials.runTrialBaseline(
						ctx.cwd,
						modelChoice,
						{
							benchmark,
							dataset,
							repo,
							force: hasFlag("--force"),
							onSnapshot: async (snapshotUpdate) => {
								trialLiveRun = snapshotUpdate;
								await applyQuestUi(ctx, currentQuest);
							},
							onProcessStart: async (pid) => {
								activeTrialPid = pid;
							},
						},
					);
					currentTrialState = result.state;
					currentProfile = result.profile;
					await emitNote(pi, ctx, result.summary);
					return;
				} finally {
					activeTrialPid = undefined;
					trialLiveRun = null;
					const nextStatus = await trials.collectFrontierTrialStatus(ctx.cwd);
					currentTrialState = nextStatus.state;
					currentProfile = nextStatus.profile;
					await applyQuestUi(ctx, currentQuest);
				}
			}

			case "status": {
				await emitNote(pi, ctx, trials.summarizeTrialStatus(await trials.collectFrontierTrialStatus(ctx.cwd)));
				return;
			}

			case "profile": {
				await emitNote(
					pi,
					ctx,
					`Trials profile ${status.profile.id}\n- target: ${status.profile.target}\n- adopted changes: ${status.profile.adoptedChanges.length}\n- same-model bias: ${status.profile.modelPolicy.preferSameModelFamily}\n- spill-to-reports: ${status.profile.contextPolicy.spillLongOutputsToReports}\n- frontier size: ${status.frontier?.frontierCandidateIds.length ?? 0}`,
				);
				return;
			}

			default: {
				await emitNote(
					pi,
					ctx,
					"Unknown /quest trials subcommand. Use /quest trials status, /quest trials prepare-benchmark, /quest trials analyze-community, /quest trials baseline, /quest trials run, /quest trials stop, or /quest trials profile.",
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
				if (!internalModeEnabled()) {
					await emitNote(pi, ctx, "Quest Trials is maintainer-only and not part of the public package surface.", "warning");
					return;
				}
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
				const prompt = `Let's plan a quest for this repository.\n\nGoal: ${remainder}\n\nDefine the validation contract before the feature list. If the goal is still ambiguous, ask clarifying questions until the requirements are unambiguous. Use the quest tools to write the proposal when you are ready.`;
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
					"Unknown /quest subcommand. Use /quest, /quest new <goal>, /quest enter, /quest exit, /quest accept, /quest pause, /quest resume, /quest abort, or /quest model <role> <provider/model[:thinking]>.",
					"warning",
				);
			}
		}
	}

	async function resolveQuestForTool(ctx: ExtensionContext, questId?: string): Promise<QuestState | null> {
		if (questId) return loadQuest(ctx.cwd, questId);
		return loadActiveQuest(ctx.cwd);
	}

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _context, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.bold(theme.fg("accent", "[quest]")), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(
			new Markdown(String(message.content), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		return box;
	});

	registerQuestTools(pi, {
		resolveQuestForTool,
		applyQuestUi,
		setCurrentQuest: (quest) => {
			currentQuest = quest;
		},
		setCurrentProfile: (profile) => {
			currentProfile = profile;
		},
		proposalReady,
		synthesizeAssertionsForQuestPlan,
		internalModeEnabled: internalModeEnabled(),
	});

	pi.registerCommand("quest", {
		description: "Open Quest Control or operate on the active quest",
		getArgumentCompletions: (prefix) => {
			const options = ["new", "enter", "exit", "accept", "pause", "resume", "abort", "model"];
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

	pi.registerShortcut(Key.ctrlAlt("q"), {
		description: "Open Quest Control",
		handler: async (ctx) => {
			const quest = await ensureCurrentQuest(ctx);
			if (!quest) return;
			await openQuestControl(ctx, quest);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("l"), {
		description: "List project quests",
		handler: async (ctx) => {
			await showQuestList(ctx);
		},
	});

	if (internalModeEnabled()) {
		pi.registerShortcut(Key.ctrlAlt("t"), {
			description: "Open Quest Trials",
			handler: async (ctx) => {
				await openQuestTrialsControl(ctx);
			},
		});
	}

	pi.on("resources_discover", async (_event, ctx) => {
		const activeQuest = await loadActiveQuest(ctx.cwd);
		return {
			skillPaths: discoverQuestSkillPaths(ctx.cwd, activeQuest?.id),
		};
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		lastContextUsage = ctx.getContextUsage() ?? null;
		await applyQuestUi(ctx, currentQuest);
		return undefined;
	});

	pi.on("tool_result", async (event, _ctx) => {
		const guidance = isBashToolResult(event) || isReadToolResult(event) || isGrepToolResult(event) || isFindToolResult(event) || isLsToolResult(event)
			? questToolResultGuidance({ toolName: event.toolName, details: event.details, input: event.input })
			: null;
		if (!guidance) return undefined;
		const alreadyPresent = event.content.some((part) => part.type === "text" && part.text.includes(guidance));
		if (alreadyPresent) return undefined;
		return {
			content: [...event.content, { type: "text", text: guidance }],
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const quest = currentQuest ?? (await loadActiveQuest(ctx.cwd));
			const trialState = currentTrialState ?? (internalModeEnabled() ? await loadQuestTrialState(ctx.cwd, { ensure: true }) : null);
			const env = buildQuestShellEnvironment(ctx.cwd, quest, trialState);
			if (Object.keys(env).length > 0) {
				event.input.command = prefixQuestShellCommand(event.input.command, env);
			}
		}
		if ((isToolCallEventType("write", event) || isToolCallEventType("edit", event)) && typeof event.input.path === "string") {
			const reason = protectedQuestArtifactReason(ctx.cwd, event.input.path);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const questModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === QUEST_MODE_ENTRY)
			.pop() as { data?: { enabled?: boolean } } | undefined;
		questModeEnabled = questModeEntry?.data?.enabled === true;
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
				text: `Let's plan a quest for this repository.\n\nGoal: ${trimmed}\n\nIf the goal is still ambiguous, ask clarifying questions until the requirements are unambiguous. Use the quest tools to persist the proposal when you are ready.`,
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
