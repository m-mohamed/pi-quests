import { describe, expect, test } from "bun:test";
import { markQuestAborted, prepareQuestForResume, processExists } from "../src/runtime-core.js";
import type { QuestState } from "../src/types.js";

function sampleQuest(): QuestState {
	return {
		id: "quest-runtime",
		projectId: "project-runtime",
		cwd: "/tmp/runtime",
		title: "Runtime quest",
		goal: "Harden runtime controls",
		status: "running",
		defaultModel: {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		},
		roleModels: {},
		plan: {
			title: "Runtime quest",
			summary: "Harden abort and recovery behavior",
			successCriteria: ["Active runs can be aborted safely"],
			milestones: [
				{
					id: "m1",
					title: "Implement runtime reliability",
					summary: "Add abort and recovery support",
					successCriteria: ["Abort and resume work"],
					status: "running",
				},
			],
			features: [
				{
					id: "f1",
					title: "Abort active worker",
					summary: "Abort the active worker and preserve completed work",
					milestoneId: "m1",
					acceptanceCriteria: ["Worker can be aborted"],
					status: "running",
				},
			],
			validationContract: {
				summary: "Runtime behavior is explicit.",
				milestoneExpectations: [],
				featureChecks: [],
				criteria: [],
				weakValidationWarnings: [],
			},
		},
		planHash: "runtime-hash",
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

describe("quest runtime core", () => {
	test("markQuestAborted blocks the active work and records interruption metadata", () => {
		const quest = sampleQuest();
		const summary = markQuestAborted(quest, 123456);

		expect(summary).toContain('Operator aborted worker feature "Abort active worker".');
		expect(quest.status).toBe("aborted");
		expect(quest.shipReadiness).toBe("not_ready");
		expect(quest.plan?.features[0]?.status).toBe("blocked");
		expect(quest.plan?.milestones[0]?.status).toBe("blocked");
		expect(quest.lastInterruption?.interruptedAt).toBe(123456);
		expect(quest.lastInterruption?.pid).toBe(process.pid);
		expect(quest.activeRun).toBeUndefined();
	});

	test("prepareQuestForResume reopens only the interrupted unfinished work", () => {
		const quest = sampleQuest();
		markQuestAborted(quest, 123456);

		const changed = prepareQuestForResume(quest);

		expect(changed).toBe(true);
		expect(quest.status).toBe("paused");
		expect(quest.activeRun).toBeUndefined();
		expect(quest.plan?.features[0]?.status).toBe("pending");
		expect(quest.plan?.milestones[0]?.status).toBe("pending");
		expect(quest.lastError).toBeUndefined();
	});

	test("processExists reports the current process as alive", () => {
		expect(processExists(process.pid)).toBe(true);
	});
});
