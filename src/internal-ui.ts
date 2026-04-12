import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { LiveRunSnapshot, QuestTrialState, QuestTrialStatus } from "./types.js";
import { truncate } from "./utils.js";

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

export interface TrialsWidgetModel {
	target: string;
	profileId: string;
	status: QuestTrialState["status"];
	statusColor: "accent" | "success" | "warning" | "error" | "muted";
	contextLabel?: string;
	runLabel: string;
	runStatus: string;
	iterationLabel: string;
	summary: string;
	progress: string;
}

export interface TrialsControlItem {
	value: string;
	label: string;
	description?: string;
	detailMarkdown: string;
}

export type TrialsWidgetFactory = (tui: TUI, theme: Theme) => Component;

function benchmarkLabel(state: QuestTrialState): string {
	if (!state.benchmarkFamily) return "not prepared";
	return `${state.benchmarkFamily}${state.benchmarkDataset ? ` · ${state.benchmarkDataset}` : ""}`;
}

function activeCandidateLabel(state: QuestTrialState): string {
	return state.activeRun?.candidateId ?? state.currentCandidateId ?? "none";
}

function summaryDetailMarkdown(state: QuestTrialState, profileId: string, liveRun: LiveRunSnapshot | null): string {
	return [
		"# Quest Trials",
		"",
		`- Status: ${state.status}`,
		`- Target: ${state.target}`,
		`- Profile: ${profileId}`,
		`- Benchmark: ${benchmarkLabel(state)}`,
		`- Candidate: ${activeCandidateLabel(state)}`,
		`- Frontier leader: ${state.currentCandidateId ?? "none"}`,
		`- Live run: ${liveRun ? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` · ${liveRun.latestToolName}` : ""}` : "idle"}`,
		`- Updated: ${new Date(state.updatedAt).toLocaleString()}`,
		"",
		"## Latest Summary",
		state.lastSummary ?? "Trials are idle.",
	].join("\n");
}

function benchmarkDetailMarkdown(state: QuestTrialState): string {
	return [
		"# Benchmark",
		"",
		`- Family: ${state.benchmarkFamily ?? "unset"}`,
		`- Dataset: ${state.benchmarkDataset ?? "unset"}`,
		`- Run mode: ${state.benchmarkRunMode ?? "unset"}`,
		`- Target: ${state.target}`,
	].join("\n");
}

function candidateDetailMarkdown(state: QuestTrialState): string {
	return [
		"# Frontier Candidate",
		"",
		`- Active candidate: ${activeCandidateLabel(state)}`,
		`- Frontier leader: ${state.currentCandidateId ?? "none"}`,
		`- Frontier ids: ${(state.frontierCandidateIds ?? []).join(", ") || "none"}`,
		"",
		"## State Summary",
		state.lastSummary ?? "No candidate summary yet.",
	].join("\n");
}

function liveRunDetailMarkdown(state: QuestTrialState, liveRun: LiveRunSnapshot): string {
	return [
		"# Live Trials Run",
		"",
		`- Role: ${liveRun.role}`,
		`- Phase: ${liveRun.phase}`,
		`- Tool: ${liveRun.latestToolName ?? "none"}`,
		`- Message: ${liveRun.latestMessage ?? "none"}`,
		`- Candidate: ${activeCandidateLabel(state)}`,
	].join("\n");
}

export function buildTrialsWidgetModel(
	state: QuestTrialState,
	profileId: string,
	liveRun: LiveRunSnapshot | null,
	contextLabel?: string | null,
): TrialsWidgetModel {
	const runLabel = liveRun
		? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` → ${liveRun.latestToolName}` : ""}`
		: "idle";
	const runStatus = state.status === "running" ? "active" : state.status === "blocked" ? "blocked" : "idle";

	return {
		target: state.target,
		profileId,
		status: state.status,
		statusColor: trialsStatusColor(state.status),
		contextLabel: contextLabel ?? undefined,
		runLabel,
		runStatus,
		iterationLabel: state.activeRun?.candidateId ? `cand ${state.activeRun.candidateId}` : state.currentCandidateId ? `cand ${state.currentCandidateId}` : "no candidate",
		summary: truncate(state.lastSummary ?? "trials idle", 96),
		progress: state.status === "running" ? "∫ running" : state.status === "blocked" ? "⊘ blocked" : "○ idle",
	};
}

export function buildTrialsControlItems(state: QuestTrialState, profileId: string, liveRun: LiveRunSnapshot | null): TrialsControlItem[] {
	const items: TrialsControlItem[] = [
		{
			value: "summary",
			label: "Summary",
			description: `${state.status} · ${benchmarkLabel(state)}`,
			detailMarkdown: summaryDetailMarkdown(state, profileId, liveRun),
		},
		{
			value: "benchmark",
			label: "Benchmark",
			description: benchmarkLabel(state),
			detailMarkdown: benchmarkDetailMarkdown(state),
		},
		{
			value: "candidate",
			label: "Candidate",
			description: activeCandidateLabel(state),
			detailMarkdown: candidateDetailMarkdown(state),
		},
	];
	if (liveRun) {
		items.push({
			value: "live-run",
			label: "Live Run",
			description: `${liveRun.role}/${liveRun.phase}`,
			detailMarkdown: liveRunDetailMarkdown(state, liveRun),
		});
	}
	return items;
}

export function renderTrialsWidgetLines(model: TrialsWidgetModel): string[] {
	return [
		`TRIALS // target ${model.target}`,
		`Status ${model.status}  |  Profile ${model.profileId}${model.contextLabel ? `  |  ${model.contextLabel}` : ""}  |  Run ${model.runLabel}`,
		`Summary ${model.summary}`,
	];
}

export function renderTrialsActionLines(): string[] {
	return [
		"Actions /quest trials status  |  /quest trials prepare-benchmark  |  /quest trials analyze-community  |  /quest trials baseline  |  /quest trials run",
	];
}

export function createTrialsWidgetComponent(model: TrialsWidgetModel): TrialsWidgetFactory {
	const lines = renderTrialsWidgetLines(model);
	const actionLines = renderTrialsActionLines();
	return (_tui, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.bold(theme.fg(model.statusColor, lines[0] ?? "TRIALS")), 1, 0));
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
