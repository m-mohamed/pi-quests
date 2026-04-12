import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestPlanText, planningInstructions, synthesizeValidationAssertions } from "../src/plan-core.js";

test("planningInstructions advertises structured quest tools", () => {
	const prompt = planningInstructions(
		{
			id: "quest-1",
			projectId: "project-1",
			cwd: "/tmp/repo",
			title: "Quest",
			goal: "Build quest orchestration",
			status: "planning",
			config: {
				orchestratorModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
				workerModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
				validatorModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
				cwd: "/tmp/repo",
				createdAt: Date.now(),
			},
			defaultModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
			roleModels: {},
			validationReadiness: {
				summary: "Repo checks are available.",
				checks: [{ id: "checks", surface: "repo-checks", description: "npm test", status: "supported", commands: ["npm test"], evidence: [] }],
			},
			validationState: { assertions: [], updatedAt: Date.now() },
			planRevisions: [],
			pendingPlanRevisionRequests: [],
			steeringNotes: [],
			humanQaStatus: "pending",
			shipReadiness: "not_ready",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			recentRuns: [],
		},
		[],
	);

	assert.match(prompt, /quest_set_proposal/);
	assert.match(prompt, /quest_set_features/);
	assert.match(prompt, /quest_set_validation/);
	assert.match(prompt, /quest_update_state/);
	assert.match(prompt, /AGENTS\.md/);
	assert.match(prompt, /loaded skill/);
	assert.match(prompt, /validation contract before the feature list/);
	assert.ok(prompt.indexOf("quest_set_validation") < prompt.indexOf("quest_set_features"));
});

test("parseQuestPlanText accepts the quest fallback JSON shape", () => {
	const parsed = parseQuestPlanText(`
\`\`\`json
{
  "title": "Arrow",
  "summary": "Validation-first tracker",
  "risks": ["Browser validation is limited locally."],
  "environment": ["Use sqlite for local MVP."],
  "services": [{ "name": "web", "purpose": "Next.js app", "commands": ["npm run dev"], "ports": [3000] }],
  "humanQaChecklist": ["Open the board and verify issue creation manually."],
  "milestones": [{ "id": "m1", "title": "MVP", "description": "Ship the walking skeleton" }],
  "features": [{ "id": "f1", "title": "Shell", "description": "Render the shell", "milestoneId": "m1", "fulfills": ["a1"] }]
}
\`\`\`
`);

	assert.ok(parsed);
	assert.equal(parsed.plan.title, "Arrow");
	assert.equal(parsed.plan.features[0].fulfills[0], "a1");
});

test("synthesizeValidationAssertions derives assertion ids from feature mapping", () => {
	const assertions = synthesizeValidationAssertions(
		[{ id: "m1", order: 1, title: "MVP", description: "Ship it", successCriteria: [], status: "pending" }],
		[
			{
				id: "f1",
				order: 1,
				milestoneId: "m1",
				title: "Shell",
				description: "Render the shell",
				preconditions: [],
				fulfills: ["Board renders in the browser"],
				status: "pending",
			},
		],
	);

	assert.equal(assertions.length, 1);
	assert.equal(assertions[0].milestoneId, "m1");
	assert.equal(assertions[0].description, "Board renders in the browser");
});
