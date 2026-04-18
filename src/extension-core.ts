import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { getQuestPaths } from "./state-core.js";
import type { QuestTrialState, QuestState } from "./types.js";

const PROTECTED_QUEST_FILES = new Set([
	"active.json",
	"quest.json",
	"proposal.md",
	"validation-readiness.json",
	"validation-contract.md",
	"validation-state.json",
	"features.json",
	"services.yaml",
]);

function withinPath(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function discoverQuestSkillPaths(cwd: string, questId?: string): string[] {
	const rootPaths = getQuestPaths(cwd, questId ?? "__quest__");
	const skillPaths = [rootPaths.sharedSkillsDir];
	if (questId) skillPaths.unshift(getQuestPaths(cwd, questId).skillsDir);
	return skillPaths;
}

export function protectedQuestArtifactReason(cwd: string, candidatePath: string): string | null {
	const target = resolve(candidatePath);
	const basePaths = getQuestPaths(cwd, "__quest__");
	if (withinPath(basePaths.sharedSkillsDir, target)) {
		return "Quest skills must be written through quest tools, not raw file writes.";
	}
	if (!withinPath(basePaths.rootDir, target)) return null;
	const relativePath = target.slice(resolve(basePaths.rootDir).length + 1);
	if (!relativePath || relativePath === ".") return "Quest storage must be updated through quest tools, not raw file writes.";
	const segments = relativePath.split("/").filter(Boolean);
	if (segments.length === 1) {
		return PROTECTED_QUEST_FILES.has(segments[0])
			? "Quest control files must be updated through quest tools, not raw file writes."
			: null;
	}
	if (segments.length >= 2 && segments[1] === "skills") {
		return "Quest skills must be written through quest tools, not raw file writes.";
	}
	return PROTECTED_QUEST_FILES.has(segments[1])
		? "Quest control files must be updated through quest tools, not raw file writes."
		: null;
}

export function formatContextUsageLabel(usage: ContextUsage | null | undefined): string | null {
	if (!usage || usage.tokens === null || usage.percent === null) return null;
	const tokenLabel = usage.tokens >= 1000 ? `${(usage.tokens / 1000).toFixed(1)}k` : String(usage.tokens);
	const windowLabel = usage.contextWindow >= 1000 ? `${Math.round(usage.contextWindow / 1000)}k` : String(usage.contextWindow);
	return `ctx ${Math.round(usage.percent)}% · ${tokenLabel}/${windowLabel}`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildQuestShellEnvironment(
	cwd: string,
	quest: Pick<QuestState, "id" | "cwd" | "status"> | null,
	trialState: Pick<QuestTrialState, "status" | "activeProfileId" | "evalFamily" | "evalDataset"> | null,
): Record<string, string> {
	const env: Record<string, string> = {};
	if (quest && quest.cwd === cwd) {
		const paths = getQuestPaths(cwd, quest.id);
		env.PI_QUESTS_ACTIVE_QUEST_ID = quest.id;
		env.PI_QUESTS_ACTIVE_QUEST_STATUS = quest.status;
		env.PI_QUESTS_ACTIVE_QUEST_ROOT = paths.questDir;
	}
	if (trialState) {
		env.PI_QUESTS_TRIAL_STATUS = trialState.status;
		env.PI_QUESTS_TRIAL_PROFILE_ID = trialState.activeProfileId;
		if (trialState.evalFamily) env.PI_QUESTS_TRIAL_EVAL = trialState.evalFamily;
		if (trialState.evalDataset) env.PI_QUESTS_TRIAL_SUITE = trialState.evalDataset;
	}
	return env;
}

export function prefixQuestShellCommand(command: string, env: Record<string, string>): string {
	const entries = Object.entries(env);
	if (entries.length === 0) return command;
	const exports = entries.map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`).join("\n");
	return `${exports}\n${command}`;
}

export function questToolResultGuidance(input: {
	toolName: string;
	details?:
		| {
				fullOutputPath?: string;
				truncation?: unknown;
				matchLimitReached?: number;
				linesTruncated?: boolean;
				resultLimitReached?: number;
				entryLimitReached?: number;
		  }
		| undefined;
	input?: Record<string, unknown>;
}): string | null {
	if (input.toolName === "bash" && input.details?.fullOutputPath) {
		return `Full command output was spilled to ${input.details.fullOutputPath}. Read only the specific slice you need before continuing.`;
	}
	if (input.toolName === "read" && input.details?.truncation && typeof input.input?.path === "string") {
		return `Read output was truncated. Re-read ${input.input.path} with offset/limit to inspect the exact region you need.`;
	}
	if (input.toolName === "grep" && (input.details?.truncation || input.details?.matchLimitReached || input.details?.linesTruncated)) {
		const path = typeof input.input?.path === "string" ? input.input.path : ".";
		const pattern = typeof input.input?.pattern === "string" ? input.input.pattern : "pattern";
		return `Search results were truncated. Re-run grep for ${pattern} under ${path} with a narrower path, tighter glob, or a lower-context slice before acting on partial matches.`;
	}
	if (input.toolName === "find" && (input.details?.truncation || input.details?.resultLimitReached)) {
		const path = typeof input.input?.path === "string" ? input.input.path : ".";
		const pattern = typeof input.input?.pattern === "string" ? input.input.pattern : "pattern";
		return `File search hit a result limit. Narrow the find pattern ${pattern} under ${path} before choosing a target from partial results.`;
	}
	if (input.toolName === "ls" && (input.details?.truncation || input.details?.entryLimitReached)) {
		const path = typeof input.input?.path === "string" ? input.input.path : ".";
		return `Directory listing was truncated for ${path}. Re-run ls on a narrower subdirectory before assuming you saw the full tree.`;
	}
	return null;
}
