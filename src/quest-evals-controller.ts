import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ControlPanelAction, type ControlPanelOutcome, openControlPanel } from "./control-panel.js";
import { loadFrontierOptimizer, loadInternalUi } from "./quest-internal-loader.js";
import { createDefaultModelChoice, currentOrDefaultModel } from "./quest-runtime-helpers.js";
import { summarizeEvals } from "./quest-ui-controller.js";
import { terminateQuestProcess } from "./runtime-core.js";
import { loadQuestOptimizerState, saveQuestOptimizerState } from "./state-core.js";
import type { LiveRunSnapshot, QuestProfile, QuestState, QuestOptimizerState, ThinkingLevel } from "./types.js";

interface MutableOptimizerState {
	getCurrentQuest: () => QuestState | null;
	getCurrentOptimizerState: () => QuestOptimizerState | null;
	getCurrentProfile: () => QuestProfile | null;
	getOptimizerLiveRun: () => LiveRunSnapshot | null;
	getActiveOptimizerPid: () => number | undefined;
	setCurrentOptimizerState: (state: QuestOptimizerState) => void;
	setCurrentProfile: (profile: QuestProfile) => void;
	setOptimizerLiveRun: (snapshot: LiveRunSnapshot | null) => void;
	setActiveOptimizerPid: (pid: number | undefined) => void;
}

interface QuestEvalsControllerDeps extends MutableOptimizerState {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	emitNote: (content: string, level?: "info" | "warning" | "error") => Promise<void>;
	applyQuestUi: () => Promise<void>;
	internalModeEnabled: boolean;
	loadFrontierOptimizer?: typeof loadFrontierOptimizer;
	loadInternalUi?: typeof loadInternalUi;
}

function syncOptimizerStatus(state: MutableOptimizerState, optimizerState: QuestOptimizerState, profile: QuestProfile): void {
	state.setCurrentOptimizerState(optimizerState);
	state.setCurrentProfile(profile);
	if (optimizerState.status !== "running") {
		state.setActiveOptimizerPid(undefined);
		state.setOptimizerLiveRun(null);
	}
}

export async function openQuestEvalsControl(deps: QuestEvalsControllerDeps): Promise<void> {
	if (!deps.internalModeEnabled) {
		await deps.emitNote("Quest evals are maintainer-only and not part of the public package surface.", "warning");
		return;
	}
	let optimizer;
	try {
		optimizer = await (deps.loadFrontierOptimizer ?? loadFrontierOptimizer)();
	} catch (error) {
		await deps.emitNote(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	const status = await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd);
	syncOptimizerStatus(deps, status.state, status.profile);
	if (!deps.ctx.hasUI || !deps.ctx.ui.custom) {
		await deps.emitNote(summarizeEvals(optimizer.summarizeOptimizerStatus(status), deps.getOptimizerLiveRun()));
		return;
	}

	let selectedValue: string | null = null;
	while (true) {
		const nextStatus = await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd);
		syncOptimizerStatus(deps, nextStatus.state, nextStatus.profile);
		let internalUi;
		try {
			internalUi = await (deps.loadInternalUi ?? loadInternalUi)();
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
			title: "Quest Evals",
			subtitle: `${nextStatus.state.status} · ${nextStatus.profile.id}`,
			items: internalUi.buildEvalsControlItems(nextStatus.state, nextStatus.profile.id, deps.getOptimizerLiveRun()),
			selectedValue,
			actions,
		});
		if (!outcome || outcome.action === "close") return;
		selectedValue = outcome.selectedValue;
		if (outcome.action === "refresh") continue;
		await handleQuestEvalsCommand(outcome.action, deps);
	}
}

export async function handleQuestEvalsCommand(args: string, deps: QuestEvalsControllerDeps): Promise<void> {
	if (!deps.internalModeEnabled) {
		await deps.emitNote("Quest evals are maintainer-only and not part of the public package surface.", "warning");
		return;
	}
	let optimizer;
	try {
		optimizer = await (deps.loadFrontierOptimizer ?? loadFrontierOptimizer)();
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
	const status = await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd);
	syncOptimizerStatus(deps, status.state, status.profile);

	if (!trimmed) {
		await deps.emitNote(optimizer.summarizeOptimizerStatus(status));
		return;
	}

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const remainder = rest.join(" ").trim();
	const requestedEval = readFlag("--eval");
	if (requestedEval && requestedEval !== "local" && requestedEval !== "frontierswe") {
		await deps.emitNote("Unsupported eval family. Use --eval local or --eval frontierswe.", "warning");
		return;
	}
	const evaluation = requestedEval as "local" | "frontierswe" | undefined;
	const suite = readFlag("--suite") ?? (remainder && !remainder.startsWith("--") ? remainder : undefined);
	const repo = readFlag("--repo");

	switch (subcommand) {
		case "run": {
			if (deps.getCurrentOptimizerState()?.status === "running") {
				await deps.emitNote("Evals are already running.", "warning");
				return;
			}
			const currentQuest = deps.getCurrentQuest();
			const modelChoice =
				currentQuest && currentQuest.status !== "completed" && currentQuest.status !== "aborted"
					? currentOrDefaultModel(currentQuest, "orchestrator")
					: createDefaultModelChoice(deps.ctx.model ?? null, deps.pi.getThinkingLevel() as ThinkingLevel);
			const iterations = Number(readFlag("--iterations") ?? "1");
			try {
				const result = await optimizer.runOptimizerOptimization(deps.ctx.cwd, modelChoice, {
					eval: evaluation,
					suite,
					repo,
					force: hasFlag("--force"),
					iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : 1,
					onSnapshot: async (snapshotUpdate: LiveRunSnapshot) => {
						deps.setOptimizerLiveRun(snapshotUpdate);
						await deps.applyQuestUi();
					},
					onProcessStart: async (pid: number) => {
						deps.setActiveOptimizerPid(pid);
					},
				});
				syncOptimizerStatus(deps, result.state, result.profile);
				await deps.emitNote(result.summary);
				return;
			} finally {
				deps.setActiveOptimizerPid(undefined);
				deps.setOptimizerLiveRun(null);
				const nextStatus = await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd);
				syncOptimizerStatus(deps, nextStatus.state, nextStatus.profile);
				await deps.applyQuestUi();
			}
		}

		case "stop": {
			const persistedState = await loadQuestOptimizerState(deps.ctx.cwd, { ensure: true });
			const activePid = persistedState.activeRun?.pid ?? deps.getActiveOptimizerPid();
			if (typeof activePid === "number") {
				await terminateQuestProcess(activePid);
			}
			deps.setActiveOptimizerPid(undefined);
			deps.setOptimizerLiveRun(null);
			persistedState.activeRun = undefined;
			persistedState.status = "stopped";
			persistedState.lastSummary = "Evals stopped by operator.";
			await saveQuestOptimizerState(deps.ctx.cwd, persistedState);
			deps.setCurrentOptimizerState(persistedState);
			await deps.applyQuestUi();
			await deps.emitNote("Evals stopped.", "warning");
			return;
		}

		case "prepare": {
			const prepared = await optimizer.prepareOptimizerEval(deps.ctx.cwd, { eval: evaluation, suite, repo, force: hasFlag("--force") });
			deps.setCurrentOptimizerState(prepared.state);
			await deps.applyQuestUi();
			await deps.emitNote(
				`Prepared ${prepared.manifest.family}:${prepared.manifest.dataset}: ${prepared.searchSet.totalItems} search / ${prepared.holdOutSet.totalItems} hold-out items.\nNext: /quest evals baseline${evaluation ? ` --eval ${evaluation}` : ""}${suite ? ` --suite ${suite}` : ""}${repo ? ` --repo ${repo}` : ""}`,
			);
			return;
		}

		case "analyze-community": {
			const stats = await optimizer.analyzeOptimizerCommunity(deps.ctx.cwd, hasFlag("--force"));
			await deps.emitNote(`Analyzed community traces: ${stats.parsedSessions}/${stats.totalSessions} valid Pi sessions across ${Object.keys(stats.sources).length} source(s).`);
			return;
		}

		case "baseline": {
			if (deps.getCurrentOptimizerState()?.status === "running") {
				await deps.emitNote("Evals are already running.", "warning");
				return;
			}
			const currentQuest = deps.getCurrentQuest();
			const modelChoice =
				currentQuest && currentQuest.status !== "completed" && currentQuest.status !== "aborted"
					? currentOrDefaultModel(currentQuest, "orchestrator")
					: createDefaultModelChoice(deps.ctx.model ?? null, deps.pi.getThinkingLevel() as ThinkingLevel);
			try {
				const result = await optimizer.runOptimizerBaseline(deps.ctx.cwd, modelChoice, {
					eval: evaluation,
					suite,
					repo,
					force: hasFlag("--force"),
					onSnapshot: async (snapshotUpdate: LiveRunSnapshot) => {
						deps.setOptimizerLiveRun(snapshotUpdate);
						await deps.applyQuestUi();
					},
					onProcessStart: async (pid: number) => {
						deps.setActiveOptimizerPid(pid);
					},
				});
				syncOptimizerStatus(deps, result.state, result.profile);
				await deps.emitNote(result.summary);
				return;
			} finally {
				deps.setActiveOptimizerPid(undefined);
				deps.setOptimizerLiveRun(null);
				const nextStatus = await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd);
				syncOptimizerStatus(deps, nextStatus.state, nextStatus.profile);
				await deps.applyQuestUi();
			}
		}

		case "status": {
			await deps.emitNote(optimizer.summarizeOptimizerStatus(await optimizer.collectFrontierOptimizerStatus(deps.ctx.cwd)));
			return;
		}

		case "profile": {
			await deps.emitNote(
				`Eval profile ${status.profile.id}\n- target: ${status.profile.target}\n- adopted changes: ${status.profile.adoptedChanges.length}\n- same-model bias: ${status.profile.modelPolicy.preferSameModelFamily}\n- spill-to-reports: ${status.profile.contextPolicy.spillLongOutputsToReports}\n- frontier size: ${status.frontier?.frontierCandidateIds.length ?? 0}`,
			);
			return;
		}

		default: {
			await deps.emitNote(
				"Unknown /quest evals subcommand. Use /quest evals status, /quest evals prepare, /quest evals analyze-community, /quest evals baseline, /quest evals run, /quest evals stop, or /quest evals profile.",
				"warning",
			);
		}
	}
}
