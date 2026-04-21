import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { registerQuestSubcommand, unregisterQuestSubcommand } from "@m-mohamed/pi-quests-core/quest-subcommands";
import { handleQuestEvalsCommand, openQuestEvalsControl } from "./quest-evals-controller.js";
import { loadRuntimeProfile } from "./quest-internal-loader.js";
import { loadActiveQuest } from "./state-core.js";
import type { LiveRunSnapshot, QuestProfile, QuestState, QuestOptimizerState } from "./types.js";

const CUSTOM_MESSAGE_TYPE = "pi-quests";

async function emitNote(pi: ExtensionAPI, ctx: ExtensionContext, content: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(content, level);
	pi.sendMessage({ customType: CUSTOM_MESSAGE_TYPE, content, display: true }, { triggerTurn: false });
}

export default function questEvalsExtension(pi: ExtensionAPI) {
	let currentQuest: QuestState | null = null;
	let currentProfile: QuestProfile | null = null;
	let currentOptimizerState: QuestOptimizerState | null = null;
	let optimizerLiveRun: LiveRunSnapshot | null = null;
	let activeOptimizerPid: number | undefined;

	async function refreshRuntimeProfile(cwd: string, ensure = false) {
		const runtime = await loadRuntimeProfile(cwd, { ensure });
		currentOptimizerState = runtime.optimizerState;
		currentProfile = runtime.profile;
		return runtime;
	}

	const subcommandProvider = {
		name: "evals",
		description: "Open Quest eval controls",
		getArgumentCompletions: (prefix: string) => {
			const options = ["prepare", "analyze-community", "baseline", "run", "status", "stop", "profile"];
			return options.filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
		},
		handler: async (args: string, commandCtx: { pi: ExtensionAPI; ctx: ExtensionContext; emitNote: (content: string, level?: "info" | "warning" | "error") => Promise<void> }) => {
			currentQuest = await loadActiveQuest(commandCtx.ctx.cwd);
			if (!currentProfile || !currentOptimizerState) {
				await refreshRuntimeProfile(commandCtx.ctx.cwd, true);
			}
			await handleQuestEvalsCommand(args, {
				pi: commandCtx.pi,
				ctx: commandCtx.ctx,
				getCurrentQuest: () => currentQuest,
				getCurrentOptimizerState: () => currentOptimizerState,
				getCurrentProfile: () => currentProfile,
				getOptimizerLiveRun: () => optimizerLiveRun,
				getActiveOptimizerPid: () => activeOptimizerPid,
				setCurrentOptimizerState: (state) => {
					currentOptimizerState = state;
				},
				setCurrentProfile: (profile) => {
					currentProfile = profile;
				},
				setOptimizerLiveRun: (snapshot) => {
					optimizerLiveRun = snapshot;
				},
				setActiveOptimizerPid: (pid) => {
					activeOptimizerPid = pid;
				},
				emitNote: commandCtx.emitNote,
				applyQuestUi: async () => {},
			});
		},
	} satisfies Parameters<typeof registerQuestSubcommand>[0];

	registerQuestSubcommand(subcommandProvider);

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Open Quest Evals",
		handler: async (ctx) => {
			currentQuest = await loadActiveQuest(ctx.cwd);
			await refreshRuntimeProfile(ctx.cwd, true);
			await openQuestEvalsControl({
				pi,
				ctx,
				getCurrentQuest: () => currentQuest,
				getCurrentOptimizerState: () => currentOptimizerState,
				getCurrentProfile: () => currentProfile,
				getOptimizerLiveRun: () => optimizerLiveRun,
				getActiveOptimizerPid: () => activeOptimizerPid,
				setCurrentOptimizerState: (state) => {
					currentOptimizerState = state;
				},
				setCurrentProfile: (profile) => {
					currentProfile = profile;
				},
				setOptimizerLiveRun: (snapshot) => {
					optimizerLiveRun = snapshot;
				},
				setActiveOptimizerPid: (pid) => {
					activeOptimizerPid = pid;
				},
				emitNote: async (content, level = "info") => emitNote(pi, ctx, content, level),
				applyQuestUi: async () => {},
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentQuest = await loadActiveQuest(ctx.cwd);
		await refreshRuntimeProfile(ctx.cwd, true);
	});

	pi.on("session_shutdown", async () => {
		unregisterQuestSubcommand("evals");
	});
}
