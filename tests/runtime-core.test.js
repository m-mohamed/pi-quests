import test from "node:test";
import assert from "node:assert/strict";
import { markQuestAborted, prepareQuestForResume } from "../src/runtime-core.js";

function sampleQuest() {
	return {
		id: "quest-runtime",
		projectId: "project-runtime",
		cwd: "/tmp/runtime",
		title: "Runtime quest",
		goal: "Harden runtime controls",
		status: "running",
		config: {
			orchestratorModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
			workerModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validatorModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			cwd: "/tmp/runtime",
			createdAt: Date.now(),
		},
		defaultModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
		roleModels: {},
		plan: {
			title: "Runtime quest",
			summary: "Harden abort and recovery behavior",
			risks: [],
			environment: [],
			services: [],
			humanQaChecklist: ["Review the resumed quest manually."],
			milestones: [{ id: "m1", order: 1, title: "Runtime", description: "Add abort support", successCriteria: [], status: "running" }],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Abort active worker",
					description: "Abort the active worker and preserve completed work",
					preconditions: [],
					fulfills: ["a1"],
					status: "running",
				},
			],
		},
		validationState: { assertions: [], updatedAt: Date.now() },
		validationReadiness: { summary: "", checks: [] },
		planRevisions: [],
		pendingPlanRevisionRequests: [],
		steeringNotes: [],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
		activeRun: {
			role: "worker",
			kind: "feature",
			pid: process.pid,
			featureId: "f1",
			milestoneId: "m1",
			phase: "streaming",
			startedAt: Date.now() - 1000,
		},
	};
}

test("markQuestAborted blocks the active work", () => {
	const quest = sampleQuest();
	const summary = markQuestAborted(quest, 123456);
	assert.match(summary, /Operator aborted worker feature/);
	assert.equal(quest.status, "aborted");
	assert.equal(quest.plan.features[0].status, "blocked");
	assert.equal(quest.plan.milestones[0].status, "blocked");
});

test("prepareQuestForResume reopens the interrupted work", () => {
	const quest = sampleQuest();
	markQuestAborted(quest, 123456);
	const changed = prepareQuestForResume(quest);
	assert.equal(changed, true);
	assert.equal(quest.status, "paused");
	assert.equal(quest.plan.features[0].status, "pending");
	assert.equal(quest.plan.milestones[0].status, "pending");
});
