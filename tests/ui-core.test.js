import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestWidgetModel, buildTrialsWidgetModel, renderQuestActionLines, renderQuestWidgetLines, renderTrialsActionLines, renderTrialsWidgetLines } from "../src/ui-core.js";

function sampleQuest() {
	return {
		id: "quest-ui",
		projectId: "project-ui",
		cwd: "/tmp/pi-quests-ui",
		title: "Quest UI",
		goal: "Ship the landing page",
		status: "planning",
		config: {
			orchestratorModel: { provider: "openai-codex", model: "gpt-5.4", thinkingLevel: "high" },
			workerModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validatorModel: { provider: "openai-codex", model: "gpt-5.4-mini", thinkingLevel: "high" },
			validationConcurrency: 2,
			cwd: "/tmp/pi-quests-ui",
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
			milestones: [{ id: "m1", order: 1, title: "Landing page", description: "Ship the page", successCriteria: [], status: "pending" }],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Create the landing page shell",
					description: "Render the blue landing page",
					preconditions: [],
					fulfills: ["landing-page-visible"],
					status: "pending",
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
		lastSummary: "Dry-run validation readiness captured.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		recentRuns: [],
	};
}

test("quest widget model renders a structured quest panel", () => {
	const model = buildQuestWidgetModel(sampleQuest(), { role: "validator", phase: "readiness", updatedAt: Date.now(), latestToolName: "tool_planning" }, true);
	const lines = renderQuestWidgetLines(model);

	assert.equal(lines[0], "QUEST // Blue landing page");
	assert.match(lines[1], /Status planning/);
	assert.match(lines[1], /quest on/);
	assert.match(lines[3], /Milestone Landing page/);
	assert.match(lines[4], /Validation \[/);
	assert.match(lines[5], /Summary Dry-run validation readiness captured/);
	assert.deepEqual(renderQuestActionLines("proposal_ready"), ["Actions /quest accept  |  /quest  |  /quests  |  /quest trials"]);
});

test("trials widget model renders the trial panel", () => {
	const model = buildTrialsWidgetModel(
		{
			projectId: "project-ui",
			target: "repo",
			activeProfileId: "repo-project-ui",
			benchmarkFamily: "terminal-bench",
			benchmarkDataset: "terminal-bench-sample@2.0",
			currentCandidateId: "001",
			status: "running",
			lastSummary: "Candidate 001 archived. Leader 001 is active on terminal-bench-sample@2.0.",
			updatedAt: Date.now(),
		},
		"repo-project-ui",
		{ role: "trial", phase: "search-benchmark", updatedAt: Date.now(), latestToolName: "quest_trials_set_profile" },
	);
	const lines = renderTrialsWidgetLines(model);

	assert.equal(lines[0], "TRIALS // target repo");
	assert.match(lines[1], /Status running/);
	assert.match(lines[1], /Profile repo-project-ui/);
	assert.match(lines[2], /Candidate 001 archived/);
	assert.deepEqual(renderTrialsActionLines(), [
		"Actions /quest trials status  |  /quest trials prepare-benchmark  |  /quest trials analyze-community  |  /quest trials baseline  |  /quest trials run",
	]);
});
