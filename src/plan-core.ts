import { createHash } from "node:crypto";
import { promptSurfaceText } from "./profile-core.js";
import type {
	LearnedWorkflow,
	ParsedQuestPlan,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestProfile,
	QuestPlanRevisionRequest,
	QuestState,
	ValidationAssertion,
	ValidationCriticality,
	ValidationMethod,
} from "./types.js";
import { unique, truncate } from "./utils.js";

function inferValidationMethod(text: string): ValidationMethod {
	const normalized = text.toLowerCase();
	if (/(browser|ui|screen|render|click|flow|journey|visual|page)/.test(normalized)) return "user_surface";
	if (/(lint|typecheck|build|test|command|api|route|request|server)/.test(normalized)) return "command";
	if (/(inspect|read|schema|config|review|diff)/.test(normalized)) return "read_only";
	return "manual";
}

function inferCriticality(text: string): ValidationCriticality {
	return /(critical|must|never|blocking|required)/i.test(text) ? "critical" : "important";
}

export function synthesizeValidationAssertions(milestones: QuestMilestone[], features: QuestFeature[]): ValidationAssertion[] {
	const assertions: ValidationAssertion[] = [];
	for (const feature of features) {
		const milestoneId = feature.milestoneId || milestones[0]?.id || "m1";
		const criteria = feature.fulfills.length > 0 ? feature.fulfills : feature.preconditions.length > 0 ? feature.preconditions : [feature.description];
		for (const criterion of criteria) {
			assertions.push({
				id: `${feature.id}-assertion-${assertions.length + 1}`,
				milestoneId,
				description: criterion,
				method: inferValidationMethod(criterion),
				criticality: inferCriticality(criterion),
				status: "pending",
				evidence: [],
				featureIds: [feature.id],
			});
		}
	}
	return assertions;
}

function normalizeMilestones(payload: any[]): QuestMilestone[] {
	return payload.map((milestone, index) => ({
		id: String(milestone.id || `m${index + 1}`),
		order: Number.isFinite(milestone.order) ? Number(milestone.order) : index + 1,
		title: String(milestone.title || `Milestone ${index + 1}`),
		description: String(milestone.description || milestone.summary || milestone.title || `Milestone ${index + 1}`),
		successCriteria: Array.isArray(milestone.successCriteria) ? milestone.successCriteria.map(String) : [],
		validationPrompt: milestone.validationPrompt ? String(milestone.validationPrompt) : undefined,
		status: milestone.status === "running" || milestone.status === "completed" || milestone.status === "blocked" ? milestone.status : "pending",
		summary: milestone.summary ? String(milestone.summary) : undefined,
	}));
}

function normalizeFeatures(payload: any[], milestoneIds: Set<string>): QuestFeature[] {
	return payload.map((feature, index) => {
		const milestoneId = String(feature.milestoneId || [...milestoneIds][0] || "m1");
		return {
			id: String(feature.id || `f${index + 1}`),
			order: Number.isFinite(feature.order) ? Number(feature.order) : index + 1,
			milestoneId: milestoneIds.has(milestoneId) ? milestoneId : [...milestoneIds][0] || "m1",
			title: String(feature.title || `Feature ${index + 1}`),
			description: String(feature.description || feature.summary || feature.title || `Feature ${index + 1}`),
			preconditions: Array.isArray(feature.preconditions) ? feature.preconditions.map(String) : [],
			fulfills: Array.isArray(feature.fulfills)
				? feature.fulfills.map(String)
				: Array.isArray(feature.acceptanceCriteria)
					? feature.acceptanceCriteria.map(String)
					: [],
			status: feature.status === "running" || feature.status === "completed" || feature.status === "blocked" || feature.status === "skipped" ? feature.status : "pending",
			handoff: feature.handoff ? String(feature.handoff) : undefined,
			workerPrompt: feature.workerPrompt ? String(feature.workerPrompt) : undefined,
			summary: feature.summary ? String(feature.summary) : undefined,
			acceptanceCriteria: Array.isArray(feature.acceptanceCriteria) ? feature.acceptanceCriteria.map(String) : undefined,
		};
	});
}

export function normalizeQuestPlan(payload: any): QuestPlan | null {
	if (!payload || typeof payload !== "object") return null;
	if (typeof payload.title !== "string" || !Array.isArray(payload.milestones) || !Array.isArray(payload.features)) return null;
	const milestones = normalizeMilestones(payload.milestones);
	if (milestones.length === 0) return null;
	const features = normalizeFeatures(payload.features, new Set(milestones.map((milestone) => milestone.id)));
	if (features.length === 0) return null;

	return {
		title: payload.title,
		summary: String(payload.summary || payload.title),
		goal: payload.goal ? String(payload.goal) : undefined,
		risks: Array.isArray(payload.risks) ? payload.risks.map(String) : [],
		environment: Array.isArray(payload.environment) ? payload.environment.map(String) : [],
		services: Array.isArray(payload.services)
			? payload.services
					.filter((service: any) => service && typeof service === "object")
					.map((service: any) => ({
						name: String(service.name || "service"),
						purpose: String(service.purpose || service.description || ""),
						commands: Array.isArray(service.commands) ? service.commands.map(String) : [],
						ports: Array.isArray(service.ports) ? service.ports.map((port: unknown) => Number(port)).filter(Number.isFinite) : undefined,
						notes: Array.isArray(service.notes) ? service.notes.map(String) : undefined,
					}))
			: [],
		validationSummary: payload.validationSummary ? String(payload.validationSummary) : undefined,
		humanQaChecklist: Array.isArray(payload.humanQaChecklist)
			? payload.humanQaChecklist.map(String)
			: ["Review the primary user flows manually before shipping."],
		milestones,
		features,
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

function loadedSessionContextGuidance(): string {
	return `Pi already loads repo/global AGENTS.md instructions, relevant contextual files, and matching skills when they exist.
- Treat that loaded context as binding instead of optional flavor.
- Reuse a loaded skill when it fits the task instead of improvising a fresh workflow.
- If AGENTS or a loaded skill conflicts with your default instinct, follow the loaded instruction.`;
}

export function planningInstructions(quest: QuestState, workflows: LearnedWorkflow[], profile?: QuestProfile): string {
	const readinessSummary = quest.validationReadiness?.summary ?? "No dry-run validation readiness summary captured yet.";
	const readinessLines =
		quest.validationReadiness?.checks.length
			? quest.validationReadiness.checks
					.map(
						(check) =>
							`- ${check.surface} [${check.status}] ${check.description}${
								check.notes ? `\n  Notes: ${check.notes}` : ""
							}${check.commands.length ? `\n  Commands: ${check.commands.join(", ")}` : ""}`,
					)
					.join("\n")
			: "- No validation checks captured yet.";
	const policyLines = profile ? promptSurfaceText(profile, "planning") : "- Build the smallest viable implementation first.";

	return `[QUEST PLANNING ACTIVE]
You are acting as the quest orchestrator inside Pi.

Goal:
${quest.goal}

Existing project learned workflows:
${learnedWorkflowSection(workflows)}

Dry-run validation readiness:
${readinessSummary}

${readinessLines}

Profile surface policy:
${policyLines}

Loaded session context:
${loadedSessionContextGuidance()}

Use the structured quest tools instead of editing quest control files manually:
- quest_set_proposal
- quest_set_validation
- quest_set_features
- quest_set_services
- quest_write_skill
- quest_update_state

Planning requirements:
- If the goal is still ambiguous, ask clarifying questions until the requirements are unambiguous before finalizing the proposal.
- Treat the quest as a validation-first runtime: define the validation contract before the feature list.
- Build the smallest viable implementation first.
- Keep execution serial by default.
- Break work into milestones with explicit validation boundaries.
- Keep the orchestrator high-level; do not bake worker-level implementation details into the contract.
- Include risks, environment assumptions, services, and a human QA checklist.
- Every feature must map to validation assertion ids through "fulfills".
- Reuse the dry-run readiness results; do not claim unsupported validation surfaces are fully automated.
- If a validation surface is weak, write that into the validation state or readiness notes instead of hiding it.

When the proposal is ready:
1. Call quest_set_proposal with the title, summary, milestones, risks, environment, and human QA checklist.
2. Call quest_set_validation with the finalized assertions and any readiness updates. The contract comes before feature decomposition.
3. Call quest_set_features with the ordered features and their fulfills/preconditions/handoff.
4. Call quest_set_services with the service definitions and services YAML.
5. Optionally call quest_write_skill for any reusable generated skill.
6. Call quest_update_state with status="proposal_ready" and a concise summary.

After those tool calls, reply with a short human-readable summary of what is ready for review. Do not emit a giant JSON blob unless tool calling is unavailable.`;
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

export function revisionInstructions(quest: QuestState, requests: QuestPlanRevisionRequest[], workflows: LearnedWorkflow[], profile?: QuestProfile): string {
	const policyLines = profile ? promptSurfaceText(profile, "plan-revision") : "- Preserve completed work.\n- Keep the quest serial by default.";
	return `Revise only the remaining quest plan.

Rules:
- Preserve completed milestones and completed features.
- Only change unfinished work and unfinished validation.
- Turn validator findings into the smallest targeted fix features that close specific assertions.
- Keep the quest serial by default.
- Do not edit repository files.
- Return the full updated quest plan as JSON.

Profile surface policy:
${policyLines}

Loaded session context:
${loadedSessionContextGuidance()}

Current quest title: ${quest.plan?.title ?? quest.title}

Pending revision requests:
${summarizeRevisionRequests(requests)}

Learned workflows for this project:
${learnedWorkflowSection(workflows)}

Current plan JSON:
\`\`\`json
${JSON.stringify(quest.plan, null, 2)}
\`\`\`

Current validation state JSON:
\`\`\`json
${JSON.stringify(quest.validationState, null, 2)}
\`\`\``;
}

export function defaultHumanQaChecklist(plan: QuestPlan): string[] {
	const checklist = plan.humanQaChecklist.length > 0 ? plan.humanQaChecklist : [`Review the primary flow for ${truncate(plan.title, 80)}.`];
	return unique(checklist);
}
