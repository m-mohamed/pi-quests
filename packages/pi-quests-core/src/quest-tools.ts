import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getQuestPaths, saveQuest } from "./state-core.js";
import type { QuestState, ValidationSurfaceStatus } from "./types.js";

interface QuestToolRegistrationDeps {
	resolveQuestForTool: (ctx: ExtensionContext, questId?: string) => Promise<QuestState | null>;
	applyQuestUi: (ctx: ExtensionContext, quest: QuestState | null) => Promise<void>;
	setCurrentQuest: (quest: QuestState) => void;
	proposalReady: (quest: QuestState) => boolean;
	synthesizeAssertionsForQuestPlan: (quest: QuestState) => void;
}

export function registerQuestTools(pi: ExtensionAPI, deps: QuestToolRegistrationDeps): void {
	pi.registerTool({
		name: "quest_set_proposal",
		label: "quest_set_proposal",
		description: "Persist the current quest proposal, milestones, risks, environment, and human QA checklist.",
		promptSnippet: "Persist a quest proposal and milestone outline",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			title: Type.String(),
			summary: Type.String(),
			risks: Type.Optional(Type.Array(Type.String())),
			environment: Type.Optional(Type.Array(Type.String())),
			humanQaChecklist: Type.Optional(Type.Array(Type.String())),
			validationSummary: Type.Optional(Type.String()),
			proposalMarkdown: Type.Optional(Type.String()),
			milestones: Type.Array(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.String(),
					order: Type.Optional(Type.Number()),
					successCriteria: Type.Optional(Type.Array(Type.String())),
					validationPrompt: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }], details: undefined };
			quest.title = params.title;
			quest.proposalMarkdown = params.proposalMarkdown;
			quest.plan = {
				title: params.title,
				summary: params.summary,
				goal: quest.goal,
				risks: params.risks ?? quest.plan?.risks ?? [],
				environment: params.environment ?? quest.plan?.environment ?? [],
				services: quest.plan?.services ?? [],
				validationSummary: params.validationSummary ?? quest.plan?.validationSummary,
				humanQaChecklist: params.humanQaChecklist ?? quest.plan?.humanQaChecklist ?? ["Review the primary user flows manually before shipping."],
				milestones: params.milestones.map((milestone: any, index: number) => ({
					id: milestone.id,
					order: milestone.order ?? index + 1,
					title: milestone.title,
					description: milestone.description,
					successCriteria: milestone.successCriteria ?? [],
					validationPrompt: milestone.validationPrompt,
					status: quest.plan?.milestones.find((existing) => existing.id === milestone.id)?.status ?? "pending",
				})),
				features: quest.plan?.features ?? [],
			};
			await saveQuest(quest);
			deps.setCurrentQuest(quest);
			await deps.applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored proposal for ${params.title} with ${params.milestones.length} milestone(s).` }],
				details: { questId: quest.id, milestoneCount: params.milestones.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_set_features",
		label: "quest_set_features",
		description: "Persist the ordered feature list for the active quest.",
		promptSnippet: "Persist quest features and their assertion mapping",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			replaceExisting: Type.Optional(Type.Boolean()),
			features: Type.Array(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.String(),
					milestoneId: Type.String(),
					order: Type.Optional(Type.Number()),
					preconditions: Type.Optional(Type.Array(Type.String())),
					fulfills: Type.Optional(Type.Array(Type.String())),
					handoff: Type.Optional(Type.String()),
					workerPrompt: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest || !quest.plan) return { content: [{ type: "text", text: "No active quest proposal found." }], details: undefined };
			const nextFeatures = params.features.map((feature: any, index: number) => ({
				id: feature.id,
				order: feature.order ?? index + 1,
				milestoneId: feature.milestoneId,
				title: feature.title,
				description: feature.description,
				preconditions: feature.preconditions ?? [],
				fulfills: feature.fulfills ?? [],
				status: quest.plan?.features.find((existing) => existing.id === feature.id)?.status ?? "pending",
				handoff: feature.handoff,
				workerPrompt: feature.workerPrompt,
			}));
			if (params.replaceExisting !== false) {
				quest.plan.features = nextFeatures;
			} else {
				const byId = new Map(quest.plan.features.map((feature) => [feature.id, feature]));
				for (const feature of nextFeatures) byId.set(feature.id, feature);
				quest.plan.features = [...byId.values()].sort((a, b) => a.order - b.order);
			}
			deps.synthesizeAssertionsForQuestPlan(quest);
			await saveQuest(quest);
			deps.setCurrentQuest(quest);
			await deps.applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored ${nextFeatures.length} feature(s).` }],
				details: { questId: quest.id, featureCount: quest.plan.features.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_set_validation",
		label: "quest_set_validation",
		description: "Persist validation readiness and assertion state for the active quest.",
		promptSnippet: "Persist quest validation readiness and assertions",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			readiness: Type.Optional(
				Type.Object({
					summary: Type.String(),
					checks: Type.Array(
						Type.Object({
							id: Type.String(),
							surface: Type.String(),
							description: Type.String(),
							status: Type.Union([Type.Literal("supported"), Type.Literal("limited"), Type.Literal("unsupported")]),
							commands: Type.Optional(Type.Array(Type.String())),
							evidence: Type.Optional(Type.Array(Type.String())),
							notes: Type.Optional(Type.String()),
						}),
					),
				}),
			),
			assertions: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						milestoneId: Type.String(),
						description: Type.String(),
						method: Type.Union([
							Type.Literal("code_review"),
							Type.Literal("procedure_review"),
							Type.Literal("user_surface"),
							Type.Literal("command"),
							Type.Literal("read_only"),
							Type.Literal("manual"),
							Type.Literal("mixed"),
						]),
						criticality: Type.Union([Type.Literal("critical"), Type.Literal("important"), Type.Literal("informational")]),
						status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("limited")])),
						evidence: Type.Optional(Type.Array(Type.String())),
						featureIds: Type.Optional(Type.Array(Type.String())),
						notes: Type.Optional(Type.String()),
						commands: Type.Optional(Type.Array(Type.String())),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }], details: undefined };
			if (params.readiness) {
				quest.validationReadiness = {
					summary: params.readiness.summary,
					checks: params.readiness.checks.map((check: any) => ({
						id: check.id,
						surface: check.surface,
						description: check.description,
						status: check.status as ValidationSurfaceStatus,
						commands: check.commands ?? [],
						evidence: check.evidence ?? [],
						notes: check.notes,
					})),
				};
			}
			if (params.assertions) {
				quest.validationState = {
					assertions: params.assertions.map((assertion: any) => ({
						id: assertion.id,
						milestoneId: assertion.milestoneId,
						description: assertion.description,
						method: assertion.method,
						criticality: assertion.criticality,
						status: assertion.status ?? "pending",
						evidence: assertion.evidence ?? [],
						featureIds: assertion.featureIds ?? [],
						notes: assertion.notes,
						commands: assertion.commands ?? [],
					})),
					updatedAt: Date.now(),
				};
			}
			await saveQuest(quest);
			deps.setCurrentQuest(quest);
			await deps.applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored validation data for ${quest.title}.` }],
				details: {
					questId: quest.id,
					assertionCount: quest.validationState?.assertions.length ?? 0,
					readinessCount: quest.validationReadiness?.checks.length ?? 0,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_set_services",
		label: "quest_set_services",
		description: "Persist service definitions and services.yaml content for the active quest.",
		promptSnippet: "Persist quest services and runtime assumptions",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			servicesYaml: Type.Optional(Type.String()),
			environment: Type.Optional(Type.Array(Type.String())),
			services: Type.Array(
				Type.Object({
					name: Type.String(),
					purpose: Type.String(),
					commands: Type.Array(Type.String()),
					ports: Type.Optional(Type.Array(Type.Number())),
					notes: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest || !quest.plan) return { content: [{ type: "text", text: "No active quest proposal found." }], details: undefined };
			quest.plan.services = params.services.map((service: any) => ({
				name: service.name,
				purpose: service.purpose,
				commands: service.commands,
				ports: service.ports,
				notes: service.notes,
			}));
			if (params.environment) quest.plan.environment = params.environment;
			if (params.servicesYaml) quest.servicesYaml = params.servicesYaml;
			await saveQuest(quest);
			deps.setCurrentQuest(quest);
			await deps.applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Stored ${params.services.length} service definition(s).` }],
				details: { questId: quest.id, serviceCount: params.services.length },
			};
		},
	});

	pi.registerTool({
		name: "quest_write_skill",
		label: "quest_write_skill",
		description: "Write a generated quest skill under the quest or shared skill directory.",
		promptSnippet: "Write a quest-local or shared skill markdown file",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			name: Type.String(),
			markdown: Type.String(),
			shared: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }], details: undefined };
			const paths = getQuestPaths(quest.cwd, quest.id);
			const dir = params.shared ? paths.sharedSkillsDir : paths.skillsDir;
			await mkdir(dir, { recursive: true });
			const file = join(dir, `${params.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.md`);
			await writeFile(file, `${params.markdown.trimEnd()}\n`, "utf-8");
			return {
				content: [{ type: "text", text: `Wrote skill ${params.name}.` }],
				details: { questId: quest.id, file, shared: params.shared === true },
			};
		},
	});

	pi.registerTool({
		name: "quest_update_state",
		label: "quest_update_state",
		description: "Update high-level quest state after proposal planning or orchestration checkpoints.",
		promptSnippet: "Update quest status or summary",
		parameters: Type.Object({
			questId: Type.Optional(Type.String()),
			status: Type.Optional(
				Type.Union([
					Type.Literal("planning"),
					Type.Literal("proposal_ready"),
					Type.Literal("running"),
					Type.Literal("paused"),
					Type.Literal("blocked"),
					Type.Literal("completed"),
					Type.Literal("aborted"),
				]),
			),
			lastSummary: Type.Optional(Type.String()),
			lastError: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quest = await deps.resolveQuestForTool(ctx, params.questId);
			if (!quest) return { content: [{ type: "text", text: "No active quest found." }], details: undefined };
			if (params.status) {
				if (params.status === "proposal_ready" && !deps.proposalReady(quest)) {
					return {
						content: [
							{
								type: "text",
								text: "Quest cannot move to proposal_ready until proposal, features, validation, and readiness artifacts are present.",
							},
						],
						details: undefined,
					};
				}
				quest.status = params.status;
			}
			if (params.lastSummary) quest.lastSummary = params.lastSummary;
			if (params.lastError !== undefined) quest.lastError = params.lastError || undefined;
			await saveQuest(quest);
			deps.setCurrentQuest(quest);
			await deps.applyQuestUi(ctx, quest);
			return {
				content: [{ type: "text", text: `Updated quest state to ${quest.status}.` }],
				details: { questId: quest.id, status: quest.status },
			};
		},
	});
}
