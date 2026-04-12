import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import { defaultHumanQaChecklist, synthesizeValidationAssertions } from "./plan-core.js";
import { defaultQuestProfile } from "./profile-core.js";
import { describeActiveRun } from "./runtime-core.js";
import { projectIdFor } from "./state-core.js";
import { truncate } from "./utils.js";
import type {
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
	QuestActiveRun,
	QuestFeature,
	QuestMilestone,
	QuestProfile,
	QuestRole,
	QuestState,
	QuestTrialState,
	ThinkingLevel,
	ValidationAssertion,
} from "./types.js";

const QUEST_ROLE_NAMES: QuestRole[] = ["orchestrator", "worker", "validator"];

export function createDefaultModelChoice(model: Model<any> | null, thinkingLevel: ThinkingLevel): ModelChoice {
	return {
		provider: model?.provider ?? "zai",
		model: model?.id ?? "glm-5.1",
		thinkingLevel,
	};
}

export function modelLabel(choice: ModelChoice | undefined): string {
	if (!choice) return "inherit";
	return `${choice.provider}/${choice.model}:${choice.thinkingLevel}`;
}

export function roleFromArg(arg: string): QuestRole | null {
	const normalized = arg.trim().toLowerCase();
	return QUEST_ROLE_NAMES.includes(normalized as QuestRole) ? (normalized as QuestRole) : null;
}

export function currentOrDefaultModel(quest: QuestState, role: QuestRole): ModelChoice {
	return quest.roleModels[role] ?? quest.defaultModel;
}

export function activeProfileFor(
	cwd: string,
	profile: QuestProfile | null,
	target: QuestTrialState["target"] = "repo",
): QuestProfile {
	return profile ?? defaultQuestProfile(projectIdFor(cwd), target);
}

export function syncQuestConfig(quest: QuestState) {
	quest.config.orchestratorModel = currentOrDefaultModel(quest, "orchestrator");
	quest.config.workerModel = currentOrDefaultModel(quest, "worker");
	quest.config.validatorModel = currentOrDefaultModel(quest, "validator");
}

export function currentMilestone(quest: QuestState): QuestMilestone | undefined {
	if (!quest.plan) return undefined;
	return quest.plan.milestones
		.slice()
		.sort((a, b) => a.order - b.order)
		.find((milestone) => milestone.status !== "completed");
}

export function currentMilestoneFeatures(quest: QuestState, milestoneId: string): QuestFeature[] {
	return (quest.plan?.features ?? [])
		.filter((feature) => feature.milestoneId === milestoneId)
		.sort((a, b) => a.order - b.order);
}

export function nextPendingFeature(quest: QuestState, milestoneId: string): QuestFeature | undefined {
	return currentMilestoneFeatures(quest, milestoneId).find((feature) => feature.status === "pending");
}

export function assertionCounts(quest: QuestState) {
	const assertions = quest.validationState?.assertions ?? [];
	return {
		total: assertions.length,
		passed: assertions.filter((assertion) => assertion.status === "passed").length,
		failed: assertions.filter((assertion) => assertion.status === "failed").length,
		limited: assertions.filter((assertion) => assertion.status === "limited").length,
		pending: assertions.filter((assertion) => assertion.status === "pending").length,
	};
}

export function readinessWarningCount(quest: QuestState) {
	return (quest.validationReadiness?.checks ?? []).filter((check) => check.status === "limited" || check.status === "unsupported").length;
}

export function humanQaChecklist(quest: QuestState): string[] {
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

export function questActiveRun(quest: QuestState, liveRun: LiveRunSnapshot | null): QuestActiveRun | null {
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

export function summarizeRecentRuns(quest: QuestState): string {
	if (quest.recentRuns.length === 0) return "none";
	return quest.recentRuns
		.slice(0, 4)
		.map((run) => `[${run.role}] ${run.summary}${run.latestToolName ? ` · ${run.latestToolName}` : ""}`)
		.join("\n");
}

export function summarizeQuest(
	quest: QuestState,
	workflows: LearnedWorkflow[],
	liveRun: LiveRunSnapshot | null,
	questModeEnabled: boolean,
): string {
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

export function readinessSummaryForWarnings(quest: QuestState): string {
	const weak = (quest.validationReadiness?.checks ?? []).filter((check) => check.status === "limited" || check.status === "unsupported");
	if (weak.length === 0) return "All captured validation surfaces are supported.";
	return weak.map((check) => `${check.surface}:${check.status}`).join(", ");
}

export function relevantAssertionsForPass(
	quest: QuestState,
	milestoneId: string,
	pass: "code_review" | "user_surface",
): ValidationAssertion[] {
	const assertions = (quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestoneId);
	return pass === "code_review"
		? assertions.filter((assertion) => assertion.method !== "user_surface")
		: assertions.filter((assertion) => assertion.method === "user_surface" || assertion.method === "mixed");
}

export function markAssertions(
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

export function appendCorrectiveFeatures(
	quest: QuestState,
	milestone: QuestMilestone,
	issues: string[],
	assertions: ValidationAssertion[],
) {
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

export function synthesizeAssertionsForQuestPlan(quest: QuestState) {
	if (!quest.plan) return;
	const next = synthesizeValidationAssertions(quest.plan.milestones, quest.plan.features);
	quest.validationState = {
		assertions: mergeValidationAssertions(quest.validationState?.assertions ?? [], next),
		updatedAt: Date.now(),
	};
}

export function proposalReady(quest: QuestState): boolean {
	return Boolean(quest.plan && quest.validationReadiness && quest.validationState && quest.plan.features.length > 0);
}
