import test from "node:test";
import assert from "node:assert/strict";
import { defaultQuestProfile } from "../src/trials-core.js";
import { buildFeaturePrompt, buildPlannerSystemPrompt, buildValidatorPrompt, buildWorkerSystemPrompt } from "../src/workers.js";

function sampleQuest() {
	return {
		id: "quest-prompts",
		projectId: "project-prompts",
		cwd: "/tmp/pi-quests-prompts",
		title: "Quest prompts",
		goal: "Ship the landing page",
		status: "running",
		config: {
			orchestratorModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
			workerModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validatorModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validationConcurrency: 2,
			cwd: "/tmp/pi-quests-prompts",
			createdAt: Date.now(),
		},
		defaultModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
		roleModels: {},
		plan: {
			title: "Blue landing page",
			summary: "Plan the smallest landing page implementation.",
			risks: [],
			environment: [],
			services: [],
			humanQaChecklist: ["Open the landing page locally."],
			milestones: [{ id: "m1", order: 1, title: "Landing page", description: "Ship the page", successCriteria: [], status: "running" }],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Create the landing page shell",
					description: "Render the blue landing page",
					preconditions: [],
					fulfills: ["landing-page-visible"],
					status: "running",
				},
			],
		},
		validationReadiness: {
			summary: "Repo checks are available.",
			checks: [{ id: "checks", surface: "repo-checks", description: "npm run check", status: "supported", commands: ["npm run check"], evidence: [] }],
		},
		validationState: {
			assertions: [
				{
					id: "landing-page-visible",
					milestoneId: "m1",
					description: "Landing page renders in the browser",
					method: "user_surface",
					criticality: "important",
					status: "pending",
					evidence: [],
				},
			],
			updatedAt: Date.now(),
		},
		planRevisions: [],
		pendingPlanRevisionRequests: [],
		steeringNotes: [],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
}

test("worker and validator prompts explicitly honor AGENTS and loaded skills", () => {
	const quest = sampleQuest();
	const profile = defaultQuestProfile(quest.projectId);
	const milestone = quest.plan.milestones[0];
	const feature = quest.plan.features[0];

	const featurePrompt = buildFeaturePrompt(quest, feature, milestone, [], profile);
	const validatorPrompt = buildValidatorPrompt(quest, milestone, [feature], [], "user_surface", profile);
	const workerSystemPrompt = buildWorkerSystemPrompt(profile);
	const plannerSystemPrompt = buildPlannerSystemPrompt(profile);

	assert.match(featurePrompt, /AGENTS\.md/);
	assert.match(featurePrompt, /matching skills|loaded skill/);
	assert.match(validatorPrompt, /AGENTS\.md/);
	assert.match(workerSystemPrompt, /loaded AGENTS\.md instructions/);
	assert.match(plannerSystemPrompt, /loaded AGENTS\.md instructions/);
});
