import test from "node:test";
import assert from "node:assert/strict";
import { defaultQuestProfile } from "../src/profile-core.js";
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
	assert.match(featurePrompt, /narrowest failing proof first|smallest failing test first|narrowest failing test/);
	assert.match(featurePrompt, /validator, not you, decides final correctness/);
	assert.match(validatorPrompt, /AGENTS\.md/);
	assert.match(validatorPrompt, /targeted fix features/);
	assert.match(workerSystemPrompt, /loaded AGENTS\.md instructions/);
	assert.match(workerSystemPrompt, /Do not self-approve the feature/);
	assert.match(workerSystemPrompt, /narrowest failing test before broader implementation/);
	assert.match(plannerSystemPrompt, /loaded AGENTS\.md instructions/);
	assert.match(plannerSystemPrompt, /validation contract before the feature list/);
});

test("benchmark worker prompts keep verifier and system-tool surfaces immutable", () => {
	const quest = sampleQuest();
	const profile = defaultQuestProfile(quest.projectId);
	const milestone = quest.plan.milestones[0];
	const feature = quest.plan.features[0];
	const benchmark = {
		benchmark: "terminal-bench",
		dataset: "terminal-bench-sample@2.0",
		taskId: "regex-log",
		runMode: "sample",
		adapterVersion: "quest-bench-v1",
		recordedAt: Date.now(),
		model: "openai-codex/gpt-5.4",
		score: 0,
		passed: false,
	};

	const featurePrompt = buildFeaturePrompt(quest, feature, milestone, [], profile, benchmark);
	const workerSystemPrompt = buildWorkerSystemPrompt(profile, true);

	assert.match(featurePrompt, /Treat verifier scripts, reward files, PATH-critical tools/);
	assert.match(featurePrompt, /Do not ask for human help, approval, or follow-up on benchmark tasks/);
	assert.match(featurePrompt, /re-open the exact output paths and verify/);
	assert.match(featurePrompt, /external verifier decides/);
	assert.match(featurePrompt, /finalSubmissionReady/);
	assert.match(featurePrompt, /selfCheck/);
	assert.match(workerSystemPrompt, /score sensor, not a mutable target/);
	assert.match(workerSystemPrompt, /Never modify verifier scripts, reward files, PATH-critical tools/);
	assert.match(workerSystemPrompt, /Do not request human help or leave provisional output/);
	assert.match(workerSystemPrompt, /Do not treat your own confidence as the final pass signal/);
	assert.match(workerSystemPrompt, /re-open the exact outputs and confirm a single final submission is ready/);
	assert.match(workerSystemPrompt, /After one failed or slow setup path, pivot/);
});

test("benchmark worker prompts add modality hints for unseen full-benchmark tasks", () => {
	const quest = sampleQuest();
	const profile = defaultQuestProfile(quest.projectId);
	const milestone = quest.plan.milestones[0];
	const feature = quest.plan.features[0];

	const codeFromImagePrompt = buildFeaturePrompt(quest, feature, milestone, [], profile, {
		benchmark: "terminal-bench",
		dataset: "terminal-bench@2.0",
		taskId: "code-from-image",
		runMode: "full",
		adapterVersion: "quest-bench-v1",
		recordedAt: Date.now(),
		model: "openai-codex/gpt-5.4",
		score: 0,
		passed: false,
	});
	const gitPrompt = buildFeaturePrompt(quest, feature, milestone, [], profile, {
		benchmark: "terminal-bench",
		dataset: "terminal-bench@2.0",
		taskId: "git-multibranch",
		runMode: "full",
		adapterVersion: "quest-bench-v1",
		recordedAt: Date.now(),
		model: "openai-codex/gpt-5.4",
		score: 0,
		passed: false,
	});
	const serverPrompt = buildFeaturePrompt(quest, feature, milestone, [], profile, {
		benchmark: "terminal-bench",
		dataset: "terminal-bench@2.0",
		taskId: "pypi-server",
		runMode: "full",
		adapterVersion: "quest-bench-v1",
		recordedAt: Date.now(),
		model: "openai-codex/gpt-5.4",
		score: 0,
		passed: false,
	});

	assert.match(codeFromImagePrompt, /media or binary-inspection task first/);
	assert.match(codeFromImagePrompt, /deterministic extraction\/transformation tools/);
	assert.match(gitPrompt, /Git-state recovery task first/);
	assert.match(gitPrompt, /git reflog -n 20/);
	assert.match(serverPrompt, /local service task first/);
	assert.match(serverPrompt, /verify the service locally/);
});
