import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { LiveRunSnapshot, QuestOptimizerState, QuestOptimizerStatus } from "./types.js";
import { truncate } from "./utils.js";

function evalsStatusColor(status: QuestOptimizerStatus): EvalsWidgetModel["statusColor"] {
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

export interface EvalsWidgetModel {
	target: string;
	profileId: string;
	status: QuestOptimizerState["status"];
	statusColor: "accent" | "success" | "warning" | "error" | "muted";
	contextLabel?: string;
	runLabel: string;
	runStatus: string;
	iterationLabel: string;
	summary: string;
	progress: string;
}

export interface EvalsControlItem {
	value: string;
	label: string;
	description?: string;
	detailMarkdown: string;
}

export type EvalsWidgetFactory = (tui: TUI, theme: Theme) => Component;

function evalLabel(state: QuestOptimizerState): string {
	if (!state.evalFamily) return "not prepared";
	return `${state.evalFamily}${state.evalDataset ? ` · ${state.evalDataset}` : ""}`;
}

function activeCandidateLabel(state: QuestOptimizerState): string {
	return state.activeRun?.candidateId ?? state.currentCandidateId ?? "none";
}

function summaryDetailMarkdown(state: QuestOptimizerState, profileId: string, liveRun: LiveRunSnapshot | null): string {
	return [
		"# Quest Evals",
		"",
		`- Status: ${state.status}`,
		`- Target: ${state.target}`,
		`- Profile: ${profileId}`,
		`- Eval: ${evalLabel(state)}`,
		`- Candidate: ${activeCandidateLabel(state)}`,
		`- Frontier leader: ${state.currentCandidateId ?? "none"}`,
		`- Live run: ${liveRun ? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` · ${liveRun.latestToolName}` : ""}` : "idle"}`,
		`- Updated: ${new Date(state.updatedAt).toLocaleString()}`,
		"",
		"## Latest Summary",
		state.lastSummary ?? "Evals are idle.",
	].join("\n");
}

function evalDetailMarkdown(state: QuestOptimizerState): string {
	return [
		"# Eval",
		"",
		`- Family: ${state.evalFamily ?? "unset"}`,
		`- Dataset: ${state.evalDataset ?? "unset"}`,
		`- Run mode: ${state.evalRunMode ?? "unset"}`,
		`- Target: ${state.target}`,
	].join("\n");
}

function candidateDetailMarkdown(state: QuestOptimizerState): string {
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

function liveRunDetailMarkdown(state: QuestOptimizerState, liveRun: LiveRunSnapshot): string {
	return [
		"# Live Optimizer Run",
		"",
		`- Role: ${liveRun.role}`,
		`- Phase: ${liveRun.phase}`,
		`- Tool: ${liveRun.latestToolName ?? "none"}`,
		`- Message: ${liveRun.latestMessage ?? "none"}`,
		`- Candidate: ${activeCandidateLabel(state)}`,
	].join("\n");
}

export function buildEvalsWidgetModel(
	state: QuestOptimizerState,
	profileId: string,
	liveRun: LiveRunSnapshot | null,
	contextLabel?: string | null,
): EvalsWidgetModel {
	const runLabel = liveRun
		? `${liveRun.role}/${liveRun.phase}${liveRun.latestToolName ? ` → ${liveRun.latestToolName}` : ""}`
		: "idle";
	const runStatus = state.status === "running" ? "active" : state.status === "blocked" ? "blocked" : "idle";

	return {
		target: state.target,
		profileId,
		status: state.status,
		statusColor: evalsStatusColor(state.status),
		contextLabel: contextLabel ?? undefined,
		runLabel,
		runStatus,
		iterationLabel: state.activeRun?.candidateId ? `cand ${state.activeRun.candidateId}` : state.currentCandidateId ? `cand ${state.currentCandidateId}` : "no candidate",
		summary: truncate(state.lastSummary ?? "evals idle", 96),
		progress: state.status === "running" ? "∫ running" : state.status === "blocked" ? "⊘ blocked" : "○ idle",
	};
}

export function buildEvalsControlItems(state: QuestOptimizerState, profileId: string, liveRun: LiveRunSnapshot | null): EvalsControlItem[] {
	const items: EvalsControlItem[] = [
		{
			value: "summary",
			label: "Summary",
			description: `${state.status} · ${evalLabel(state)}`,
			detailMarkdown: summaryDetailMarkdown(state, profileId, liveRun),
		},
		{
			value: "eval",
			label: "Eval",
			description: evalLabel(state),
			detailMarkdown: evalDetailMarkdown(state),
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

export function renderEvalsWidgetLines(model: EvalsWidgetModel): string[] {
	return [
		`EVALS // target ${model.target}`,
		`Status ${model.status}  |  Profile ${model.profileId}${model.contextLabel ? `  |  ${model.contextLabel}` : ""}  |  Run ${model.runLabel}`,
		`Summary ${model.summary}`,
	];
}

export function renderEvalsActionLines(): string[] {
	return [
		"Actions /quest evals status  |  /quest evals prepare  |  /quest evals analyze-community  |  /quest evals baseline  |  /quest evals run",
	];
}

export function createEvalsWidgetComponent(model: EvalsWidgetModel): EvalsWidgetFactory {
	const lines = renderEvalsWidgetLines(model);
	const actionLines = renderEvalsActionLines();
	return (_tui, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.bold(theme.fg(model.statusColor, lines[0] ?? "EVALS")), 1, 0));
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
