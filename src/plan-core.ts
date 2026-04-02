import { createHash } from "node:crypto";
import type {
	LearnedWorkflow,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestState,
	QuestValidationContract,
	QuestValidationCriterion,
	ParsedQuestPlan,
	ValidationProofStrategy,
} from "./types.js";

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function truncate(text: string, max = 140): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}

function inferProofStrategy(text: string): ValidationProofStrategy {
	const normalized = text.toLowerCase();
	if (/(browser|ui|page|screen|render|click|visual|layout)/.test(normalized)) return "browser";
	if (/(test|lint|typecheck|build|run|server|api|route|request|command)/.test(normalized)) return "command";
	if (/(inspect|read|schema|config|static|review)/.test(normalized)) return "read_only";
	return "manual";
}

function defaultProofDetails(strategy: ValidationProofStrategy): string {
	switch (strategy) {
		case "browser":
			return "Use browser automation or visual inspection available in Pi to verify the behavior.";
		case "command":
			return "Run the repository checks or domain-specific commands that prove the behavior holds.";
		case "read_only":
			return "Verify by reading the changed files or generated configuration without mutating the repo.";
		case "mixed":
			return "Use a mix of command-based and browser/read-only validation as needed.";
		case "manual":
		default:
			return "Human QA is required because Pi does not have a strong automated proof path for this criterion.";
	}
}

function computeWeakValidationWarnings(contract: QuestValidationContract): string[] {
	const warnings = [...contract.weakValidationWarnings];
	for (const criterion of contract.criteria) {
		if (criterion.proofStrategy === "manual") {
			warnings.push(`Criterion "${criterion.title}" depends on human QA.`);
		}
		if (criterion.proofStrategy === "read_only") {
			warnings.push(`Criterion "${criterion.title}" is only statically inspectable.`);
		}
		if (criterion.proofStrategy === "command" && criterion.commands.length === 0) {
			warnings.push(`Criterion "${criterion.title}" expects repo checks, but no explicit command was captured.`);
		}
	}
	return unique(warnings);
}

export function synthesizeValidationContract(
	milestones: QuestMilestone[],
	features: QuestFeature[],
	successCriteria: string[],
): QuestValidationContract {
	const milestoneExpectations = milestones.map((milestone) => ({
		milestoneId: milestone.id,
		title: milestone.title,
		expectedBehaviors: milestone.successCriteria.length > 0 ? milestone.successCriteria : [milestone.summary],
	}));

	const featureChecks = features.map((feature) => {
		const criterionIds: string[] = [];
		return {
			featureId: feature.id,
			title: feature.title,
			criterionIds,
		};
	});

	const criteria: QuestValidationCriterion[] = [];

	for (const feature of features) {
		const checks = feature.acceptanceCriteria.length > 0 ? feature.acceptanceCriteria : [feature.summary];
		for (const expectedBehavior of checks) {
			const strategy = inferProofStrategy(expectedBehavior);
			const criterionId = `${feature.id}-${criteria.length + 1}`;
			criteria.push({
				id: criterionId,
				title: truncate(expectedBehavior, 72),
				milestoneId: feature.milestoneId,
				featureIds: [feature.id],
				expectedBehavior,
				proofStrategy: strategy,
				proofDetails: defaultProofDetails(strategy),
				commands: [],
				confidence: strategy === "manual" ? "low" : strategy === "read_only" ? "medium" : "high",
			});
			featureChecks.find((item) => item.featureId === feature.id)?.criterionIds.push(criterionId);
		}
	}

	const contract: QuestValidationContract = {
		summary:
			successCriteria.length > 0
				? `Quest validation follows ${successCriteria.length} top-level success criteria.`
				: "Quest validation is synthesized from milestone and feature acceptance criteria.",
		milestoneExpectations,
		featureChecks,
		criteria,
		weakValidationWarnings: [],
	};

	contract.weakValidationWarnings = computeWeakValidationWarnings(contract);
	return contract;
}

function normalizeValidationContract(payload: any, milestones: QuestMilestone[], features: QuestFeature[], successCriteria: string[]) {
	if (!payload || typeof payload !== "object") {
		return synthesizeValidationContract(milestones, features, successCriteria);
	}

	const fallback = synthesizeValidationContract(milestones, features, successCriteria);
	const criteria = Array.isArray(payload.criteria)
		? payload.criteria
				.filter((item) => item && typeof item === "object")
				.map((item, index) => ({
					id: String(item.id || `criterion-${index + 1}`),
					title: String(item.title || truncate(String(item.expectedBehavior || `Criterion ${index + 1}`), 72)),
					milestoneId: String(item.milestoneId || features[0]?.milestoneId || milestones[0]?.id || "m1"),
					featureIds: Array.isArray(item.featureIds) ? item.featureIds.map(String) : [],
					expectedBehavior: String(item.expectedBehavior || item.title || `Criterion ${index + 1}`),
					proofStrategy: (["browser", "command", "read_only", "manual", "mixed"].includes(item.proofStrategy)
						? item.proofStrategy
						: inferProofStrategy(String(item.expectedBehavior || item.title || ""))) as ValidationProofStrategy,
					proofDetails: String(item.proofDetails || defaultProofDetails(inferProofStrategy(String(item.expectedBehavior || item.title || "")))),
					commands: Array.isArray(item.commands) ? item.commands.map(String) : [],
					confidence: item.confidence === "low" || item.confidence === "medium" || item.confidence === "high" ? item.confidence : "medium",
				}))
		: fallback.criteria;

	const contract: QuestValidationContract = {
		summary: String(payload.summary || fallback.summary),
		milestoneExpectations: Array.isArray(payload.milestoneExpectations)
			? payload.milestoneExpectations
					.filter((item) => item && typeof item === "object")
					.map((item) => ({
						milestoneId: String(item.milestoneId || milestones[0]?.id || "m1"),
						title: String(item.title || milestones.find((milestone) => milestone.id === item.milestoneId)?.title || "Milestone"),
						expectedBehaviors: Array.isArray(item.expectedBehaviors) ? item.expectedBehaviors.map(String) : [],
					}))
			: fallback.milestoneExpectations,
		featureChecks: Array.isArray(payload.featureChecks)
			? payload.featureChecks
					.filter((item) => item && typeof item === "object")
					.map((item) => ({
						featureId: String(item.featureId || features[0]?.id || "f1"),
						title: String(item.title || features.find((feature) => feature.id === item.featureId)?.title || "Feature"),
						criterionIds: Array.isArray(item.criterionIds) ? item.criterionIds.map(String) : [],
					}))
			: fallback.featureChecks,
		criteria,
		weakValidationWarnings: Array.isArray(payload.weakValidationWarnings) ? payload.weakValidationWarnings.map(String) : [],
	};

	contract.weakValidationWarnings = computeWeakValidationWarnings(contract);
	return contract;
}

function normalizeMilestones(payload: any[]): QuestMilestone[] {
	return payload.map((milestone, index) => ({
		id: String(milestone.id || `m${index + 1}`),
		title: String(milestone.title || `Milestone ${index + 1}`),
		summary: String(milestone.summary || milestone.title || `Milestone ${index + 1}`),
		successCriteria: Array.isArray(milestone.successCriteria) ? milestone.successCriteria.map(String) : [],
		validationPrompt: milestone.validationPrompt ? String(milestone.validationPrompt) : undefined,
		status: milestone.status === "running" || milestone.status === "completed" || milestone.status === "failed" || milestone.status === "blocked" ? milestone.status : "pending",
	}));
}

function normalizeFeatures(payload: any[], milestoneIds: Set<string>): QuestFeature[] {
	return payload.map((feature, index) => {
		const milestoneId = String(feature.milestoneId || `m1`);
		return {
			id: String(feature.id || `f${index + 1}`),
			title: String(feature.title || `Feature ${index + 1}`),
			summary: String(feature.summary || feature.title || `Feature ${index + 1}`),
			milestoneId: milestoneIds.has(milestoneId) ? milestoneId : [...milestoneIds][0] || "m1",
			acceptanceCriteria: Array.isArray(feature.acceptanceCriteria) ? feature.acceptanceCriteria.map(String) : [],
			workerPrompt: feature.workerPrompt ? String(feature.workerPrompt) : undefined,
			status:
				feature.status === "running" ||
				feature.status === "completed" ||
				feature.status === "failed" ||
				feature.status === "blocked" ||
				feature.status === "skipped"
					? feature.status
					: "pending",
		};
	});
}

export function normalizeQuestPlan(payload: any): QuestPlan | null {
	if (!payload || typeof payload !== "object") return null;
	if (typeof payload.title !== "string" || !Array.isArray(payload.milestones) || !Array.isArray(payload.features)) return null;
	if (payload.milestones.length === 0 || payload.features.length === 0) return null;

	const successCriteria = Array.isArray(payload.successCriteria) ? payload.successCriteria.map(String) : [];
	const milestones = normalizeMilestones(payload.milestones);
	const features = normalizeFeatures(payload.features, new Set(milestones.map((milestone) => milestone.id)));
	const validationContract = normalizeValidationContract(payload.validationContract, milestones, features, successCriteria);

	return {
		title: payload.title,
		summary: String(payload.summary || payload.title),
		successCriteria,
		milestones,
		features,
		validationContract,
	};
}

function extractJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
	for (const match of fenced) candidates.push(match[1]);
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
	return unique(candidates.map((candidate) => candidate.trim()).filter(Boolean));
}

export function parseQuestPlanText(text: string): ParsedQuestPlan | null {
	for (const candidate of extractJsonCandidates(text)) {
		try {
			const parsed = JSON.parse(candidate);
			const plan = normalizeQuestPlan(parsed);
			if (!plan) continue;
			const hash = createHash("sha1").update(JSON.stringify(plan)).digest("hex");
			return { plan, hash };
		} catch {
			continue;
		}
	}
	return null;
}

function learnedWorkflowSection(workflows: LearnedWorkflow[]): string {
	if (workflows.length === 0) return "- None yet.";
	return workflows.map((workflow) => `- ${workflow.title}: ${workflow.note}`).join("\n");
}

export function planningInstructions(quest: QuestState, workflows: LearnedWorkflow[]): string {
	return `[QUEST PLANNING ACTIVE]
You are acting as a quest orchestrator inside Pi.

Collaborate with the user to shape a quest before any execution begins.
Ask clarifying questions when needed, but once you have enough information, return a durable quest proposal.

Goal:
${quest.goal}

Existing private learned workflows for this project:
${learnedWorkflowSection(workflows)}

Requirements:
- Produce features grouped into milestones.
- Keep the plan concrete and implementation-oriented.
- Favor the smallest workable decomposition.
- Do not execute the plan yet.
- Build an explicit validation contract that maps milestone outcomes, feature checks, and proof strategies.
- If validation is weak, say so explicitly in weakValidationWarnings.
- Do not assume deploy-and-monitor behavior.
- When the plan is ready, end your response with a machine-readable JSON block.

Use this JSON shape exactly:
\`\`\`json
{
  "title": "short quest title",
  "summary": "short summary",
  "successCriteria": ["top-level outcome"],
  "milestones": [
    {
      "id": "m1",
      "title": "milestone title",
      "summary": "what this milestone achieves",
      "successCriteria": ["what validator should confirm"],
      "validationPrompt": "optional extra validator guidance"
    }
  ],
  "features": [
    {
      "id": "f1",
      "title": "feature title",
      "summary": "what the worker should do",
      "milestoneId": "m1",
      "acceptanceCriteria": ["what counts as done"],
      "workerPrompt": "optional extra worker guidance"
    }
  ],
  "validationContract": {
    "summary": "what the validation contract covers",
    "milestoneExpectations": [
      {
        "milestoneId": "m1",
        "title": "milestone title",
        "expectedBehaviors": ["user-visible or system behavior"]
      }
    ],
    "featureChecks": [
      {
        "featureId": "f1",
        "title": "feature title",
        "criterionIds": ["criterion-1"]
      }
    ],
    "criteria": [
      {
        "id": "criterion-1",
        "title": "criterion title",
        "milestoneId": "m1",
        "featureIds": ["f1"],
        "expectedBehavior": "behavior to prove",
        "proofStrategy": "browser",
        "proofDetails": "how Pi should prove it",
        "commands": [],
        "confidence": "high"
      }
    ],
    "weakValidationWarnings": []
  }
}
\`\`\`

If you still need clarification, ask questions and do not emit the JSON block yet.`;
}

export function mergeRemainingPlan(existing: QuestPlan, revised: QuestPlan): QuestPlan {
	const completedMilestones = new Map(existing.milestones.filter((item) => item.status === "completed").map((item) => [item.id, item]));
	const completedFeatures = new Map(existing.features.filter((item) => item.status === "completed").map((item) => [item.id, item]));

	const mergedMilestones = revised.milestones.map((milestone) => completedMilestones.get(milestone.id) ?? { ...milestone, status: "pending" as const });
	for (const completed of completedMilestones.values()) {
		if (!mergedMilestones.some((item) => item.id === completed.id)) mergedMilestones.unshift(completed);
	}

	const mergedFeatures = revised.features.map((feature) => completedFeatures.get(feature.id) ?? { ...feature, status: "pending" as const });
	for (const completed of completedFeatures.values()) {
		if (!mergedFeatures.some((item) => item.id === completed.id)) mergedFeatures.unshift(completed);
	}

	return {
		...revised,
		milestones: mergedMilestones,
		features: mergedFeatures,
	};
}

export function summarizeRevisionRequests(requests: QuestPlanRevisionRequest[]): string {
	if (requests.length === 0) return "- None";
	return requests.map((request) => `- [${request.source}] ${request.note}`).join("\n");
}

export function revisionInstructions(quest: QuestState, requests: QuestPlanRevisionRequest[], workflows: LearnedWorkflow[]): string {
	return `Revise the remaining quest plan.

Rules:
- Preserve completed milestones and completed features.
- You may change only unfinished work and the validation contract for unfinished work.
- Do not re-open completed work.
- Keep the quest serial by default.
- If validation is weak, state it explicitly in weakValidationWarnings.
- Return the full quest JSON with the same schema used for quest planning.

Current quest title: ${quest.plan?.title ?? quest.title}

Pending revision requests:
${summarizeRevisionRequests(requests)}

Learned workflows for this project:
${learnedWorkflowSection(workflows)}

Current plan JSON:
\`\`\`json
${JSON.stringify(quest.plan, null, 2)}
\`\`\``;
}
