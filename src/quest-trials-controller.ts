import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ControlPanelAction, type ControlPanelOutcome, openControlPanel } from "./control-panel.js";
import { loadFrontierTrials, loadInternalUi } from "./quest-internal-loader.js";
import { createDefaultModelChoice, currentOrDefaultModel } from "./quest-runtime-helpers.js";
import { summarizeTrials } from "./quest-ui-controller.js";
import { terminateQuestProcess } from "./runtime-core.js";
import { loadQuestTrialState, saveQuestTrialState } from "./state-core.js";
import type { LiveRunSnapshot, QuestProfile, QuestState, QuestTrialState, ThinkingLevel } from "./types.js";

interface MutableTrialsState {
	currentQuest: QuestState | null;
	currentTrialState: QuestTrialState | null;
	currentProfile: QuestProfile | null;
	trialLiveRun: LiveRunSnapshot | null;
	activeTrialPid?: number;
	setCurrentTrialState: (state: QuestTrialState) => void;
	setCurrentProfile: (profile: QuestProfile) => void;
	setTrialLiveRun: (snapshot: LiveRunSnapshot | null) => void;
	setActiveTrialPid: (pid: number | undefined) => void;
}

interface QuestTrialsControllerDeps extends MutableTrialsState {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	emitNote: (content: string, level?: "info" | "warning" | "error") => Promise<void>;
	applyQuestUi: () => Promise<void>;
	internalModeEnabled: boolean;
}

function syncTrialStatus(state: MutableTrialsState, trialState: QuestTrialState, profile: QuestProfile): void {
	state.setCurrentTrialState(trialState);
	state.setCurrentProfile(profile);
	if (trialState.status !== "running") {
		state.setActiveTrialPid(undefined);
		state.setTrialLiveRun(null);
	}
}

export async function openQuestTrialsControl(deps: QuestTrialsControllerDeps): Promise<void> {
	if (!deps.internalModeEnabled) {
		await deps.emitNote("Quest Trials is maintainer-only and not part of the public package surface.", "warning");
		return;
	}
	let trials;
	try {
		trials = await loadFrontierTrials();
	} catch (error) {
		await deps.emitNote(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	const status = await trials.collectFrontierTrialStatus(deps.ctx.cwd);
	syncTrialStatus(deps, status.state, status.profile);
	if (!deps.ctx.hasUI || !deps.ctx.ui.custom) {
		await deps.emitNote(summarizeTrials(trials.summarizeTrialStatus(status), deps.trialLiveRun));
		return;
	}

	let selectedValue: string | null = null;
	while (true) {
		const nextStatus = await trials.collectFrontierTrialStatus(deps.ctx.cwd);
		syncTrialStatus(deps, nextStatus.state, nextStatus.profile);
		let internalUi;
		try {
			internalUi = await loadInternalUi();
		} catch (error) {
			await deps.emitNote(error instanceof Error ? error.message : String(error), "warning");
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
		const outcome: ControlPanelOutcome<"baseline" | "run" | "stop" | "profile" | "refresh"> | null = await openControlPanel(deps.ctx, {
			title: "Quest Trials",
			subtitle: `${nextStatus.state.status} · ${nextStatus.profile.id}`,
			items: internalUi.buildTrialsControlItems(nextStatus.state, nextStatus.profile.id, deps.trialLiveRun),
			selectedValue,
			actions,
		});
		if (!outcome || outcome.action === "close") return;
		selectedValue = outcome.selectedValue;
		if (outcome.action === "refresh") continue;
		await handleQuestTrialsCommand(outcome.action, deps);
	}
}

export async function handleQuestTrialsCommand(args: string, deps: QuestTrialsControllerDeps): Promise<void> {
	if (!deps.internalModeEnabled) {
		await deps.emitNote("Quest Trials is maintainer-only and not part of the public package surface.", "warning");
		return;
	}
	let trials;
	try {
		trials = await loadFrontierTrials();
	} catch (error) {
		await deps.emitNote(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	const trimmed = args.trim();
	const readFlag = (flag: string): string | undefined => {
		const parts = trimmed.split(/\s+/);
		const index = parts.indexOf(flag);
		return index >= 0 ? parts[index + 1] : undefined;
	};
	const hasFlag = (flag: string): boolean => trimmed.split(/\s+/).includes(flag);
	const status = await trials.collectFrontierTrialStatus(deps.ctx.cwd);
	syncTrialStatus(deps, status.state, status.profile);

	if (!trimmed) {
		await deps.emitNote(trials.summarizeTrialStatus(status));
		return;
	}

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const remainder = rest.join(" ").trim();
	const requestedBenchmark = readFlag("--benchmark");
	if (requestedBenchmark && requestedBenchmark !== "terminal-bench" && requestedBenchmark !== "slopcodebench") {
		await deps.emitNote("Unsupported benchmark family. Use --benchmark terminal-bench or --benchmark slopcodebench.", "warning");
		return;
	}
	const benchmark = requestedBenchmark as "terminal-bench" | "slopcodebench" | undefined;
	const dataset = readFlag("--dataset") ?? (remainder && !remainder.startsWith("--") ? remainder : undefined);
	const repo = readFlag("--repo");

	switch (subcommand) {
		case "run": {
			if (deps.currentTrialState?.status === "running") {
				await deps.emitNote("Trials are already running.", "warning");
				return;
			}
			const modelChoice =
				deps.currentQuest && deps.currentQuest.status !== "completed" && deps.currentQuest.status !== "aborted"
					? currentOrDefaultModel(deps.currentQuest, "orchestrator")
					: createDefaultModelChoice(deps.ctx.model ?? null, deps.pi.getThinkingLevel() as ThinkingLevel);
			const iterations = Number(readFlag("--iterations") ?? "1");
			try {
				const result = await trials.runTrialOptimization(deps.ctx.cwd, modelChoice, {
					benchmark,
					dataset,
					repo,
					force: hasFlag("--force"),
					iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : 1,
					onSnapshot: async (snapshotUpdate: LiveRunSnapshot) => {
						deps.setTrialLiveRun(snapshotUpdate);
						await deps.applyQuestUi();
					},
					onProcessStart: async (pid: number) => {
						deps.setActiveTrialPid(pid);
					},
				});
				syncTrialStatus(deps, result.state, result.profile);
				await deps.emitNote(result.summary);
				return;
			} finally {
				deps.setActiveTrialPid(undefined);
				deps.setTrialLiveRun(null);
				const nextStatus = await trials.collectFrontierTrialStatus(deps.ctx.cwd);
				syncTrialStatus(deps, nextStatus.state, nextStatus.profile);
				await deps.applyQuestUi();
			}
		}

		case "stop": {
			const persistedState = await loadQuestTrialState(deps.ctx.cwd, { ensure: true });
			const activePid = persistedState.activeRun?.pid ?? deps.activeTrialPid;
			if (typeof activePid === "number") {
				await terminateQuestProcess(activePid);
			}
			deps.setActiveTrialPid(undefined);
			deps.setTrialLiveRun(null);
			persistedState.activeRun = undefined;
			persistedState.status = "stopped";
			persistedState.lastSummary = "Trials stopped by operator.";
			await saveQuestTrialState(deps.ctx.cwd, persistedState);
			deps.setCurrentTrialState(persistedState);
			await deps.applyQuestUi();
			await deps.emitNote("Trials stopped.", "warning");
			return;
		}

		case "prepare-benchmark": {
			const prepared = await trials.prepareTrialBenchmark(deps.ctx.cwd, { benchmark, dataset, repo, force: hasFlag("--force") });
			deps.setCurrentTrialState(prepared.state);
			await deps.emitNote(
				`Prepared ${prepared.manifest.family}:${prepared.manifest.dataset}: ${prepared.searchSet.totalItems} search / ${prepared.holdOutSet.totalItems} hold-out items.\nNext: /quest trials baseline${benchmark ? ` --benchmark ${benchmark}` : ""}${dataset ? ` --dataset ${dataset}` : ""}${repo ? ` --repo ${repo}` : ""}`,
			);
			return;
		}

		case "analyze-community": {
			const stats = await trials.analyzeTrialCommunity(deps.ctx.cwd, hasFlag("--force"));
			await deps.emitNote(`Analyzed community traces: ${stats.parsedSessions}/${stats.totalSessions} valid Pi sessions across ${Object.keys(stats.sources).length} source(s).`);
			return;
		}

		case "baseline": {
			if (deps.currentTrialState?.status === "running") {
				await deps.emitNote("Trials are already running.", "warning");
				return;
			}
			const modelChoice =
				deps.currentQuest && deps.currentQuest.status !== "completed" && deps.currentQuest.status !== "aborted"
					? currentOrDefaultModel(deps.currentQuest, "orchestrator")
					: createDefaultModelChoice(deps.ctx.model ?? null, deps.pi.getThinkingLevel() as ThinkingLevel);
			try {
				const result = await trials.runTrialBaseline(deps.ctx.cwd, modelChoice, {
					benchmark,
					dataset,
					repo,
					force: hasFlag("--force"),
					onSnapshot: async (snapshotUpdate: LiveRunSnapshot) => {
						deps.setTrialLiveRun(snapshotUpdate);
						await deps.applyQuestUi();
					},
					onProcessStart: async (pid: number) => {
						deps.setActiveTrialPid(pid);
					},
				});
				syncTrialStatus(deps, result.state, result.profile);
				await deps.emitNote(result.summary);
				return;
			} finally {
				deps.setActiveTrialPid(undefined);
				deps.setTrialLiveRun(null);
				const nextStatus = await trials.collectFrontierTrialStatus(deps.ctx.cwd);
				syncTrialStatus(deps, nextStatus.state, nextStatus.profile);
				await deps.applyQuestUi();
			}
		}

		case "status": {
			await deps.emitNote(trials.summarizeTrialStatus(await trials.collectFrontierTrialStatus(deps.ctx.cwd)));
			return;
		}

		case "profile": {
			await deps.emitNote(
				`Trials profile ${status.profile.id}\n- target: ${status.profile.target}\n- adopted changes: ${status.profile.adoptedChanges.length}\n- same-model bias: ${status.profile.modelPolicy.preferSameModelFamily}\n- spill-to-reports: ${status.profile.contextPolicy.spillLongOutputsToReports}\n- frontier size: ${status.frontier?.frontierCandidateIds.length ?? 0}`,
			);
			return;
		}

		default: {
			await deps.emitNote(
				"Unknown /quest trials subcommand. Use /quest trials status, /quest trials prepare-benchmark, /quest trials analyze-community, /quest trials baseline, /quest trials run, /quest trials stop, or /quest trials profile.",
				"warning",
			);
		}
	}
}
