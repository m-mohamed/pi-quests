import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestControlItems, buildQuestWidgetModel, createQuestModeWidgetComponent, createQuestWidgetComponent, renderQuestActionLines, renderQuestWidgetLines } from "../src/ui-core.js";
import { buildEvalsControlItems, buildEvalsWidgetModel, createEvalsWidgetComponent, renderEvalsActionLines, renderEvalsWidgetLines } from "../src/internal-ui.js";

function themeStub() {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
	};
}

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
	const model = buildQuestWidgetModel(
		sampleQuest(),
		{ role: "validator", phase: "readiness", updatedAt: Date.now(), latestToolName: "tool_planning" },
		true,
		"ctx 9% · 18.4k/200k",
	);
	const lines = renderQuestWidgetLines(model);

	assert.equal(lines[0], "QUEST // Blue landing page");
	assert.match(lines[1], /Status planning/);
	assert.match(lines[1], /quest on/);
	assert.match(lines[1], /ctx 9%/);
	assert.match(lines[3], /Milestone Landing page/);
	assert.match(lines[4], /Validation \[/);
	assert.match(lines[5], /Summary Dry-run validation readiness captured/);
	assert.deepEqual(renderQuestActionLines("proposal_ready"), ["Actions /quest accept  |  /quest  |  /quests"]);
});

test("quest control items expose summary, milestone, feature, and run detail markdown", () => {
	const quest = sampleQuest();
	quest.recentRuns.push({
		id: "run-1",
		role: "worker",
		startedAt: Date.now() - 1000,
		endedAt: Date.now(),
		provider: "openai-codex",
		model: "gpt-5.4-mini",
		thinkingLevel: "high",
		exitCode: 0,
		ok: true,
		summary: "Implemented the landing page shell.",
		phase: "streaming",
		events: [],
		issues: [],
	});

	const items = buildQuestControlItems(quest, { role: "worker", phase: "streaming", updatedAt: Date.now(), latestToolName: "edit" });
	assert.deepEqual(items.map((item) => item.value), ["summary", "milestone:m1", "feature:f1", "run:run-1"]);
	assert.match(items[0].detailMarkdown, /# Quest Summary/);
	assert.match(items[1].detailMarkdown, /## Features/);
	assert.match(items[2].detailMarkdown, /## Last Run/);
	assert.match(items[3].detailMarkdown, /## Stderr/);
});

test("quest widget factory renders a single native widget with actions", () => {
	const model = buildQuestWidgetModel(sampleQuest(), null, true, "ctx 4% · 8.0k/200k");
	const component = createQuestWidgetComponent(model)({}, themeStub());
	const output = component.render(120).join("\n");

	assert.match(output, /QUEST \/\/ Blue landing page/);
	assert.match(output, /Status planning/);
	assert.match(output, /Actions \/quest new  \|  \/quest  \|  \/quests/);
});

test("quest mode widget factory renders the Pi-native ready panel", () => {
	const component = createQuestModeWidgetComponent("ctx 4% · 8.0k/200k")({}, themeStub());
	const output = component.render(120).join("\n");

	assert.match(output, /QUEST \/\/ ready/);
	assert.match(output, /Status quest mode on  \|  ctx 4% · 8.0k\/200k  \|  Active none/);
	assert.match(output, /Actions \/quest new <goal>  \|  \/quests/);
});

test("evals widget model renders the optimizer panel", () => {
	const model = buildEvalsWidgetModel(
		{
			projectId: "project-ui",
			target: "repo",
			activeProfileId: "repo-project-ui",
			evalFamily: "frontierswe",
			evalDataset: "frontierswe-sample@v1",
			currentCandidateId: "001",
			status: "running",
			lastSummary: "Candidate 001 archived. Leader 001 is active on frontierswe-sample@v1.",
			updatedAt: Date.now(),
		},
		"repo-project-ui",
		{ role: "optimizer", phase: "search-eval", updatedAt: Date.now(), latestToolName: "quest_optimizer_set_profile" },
		"ctx 12% · 24.0k/200k",
	);
	const lines = renderEvalsWidgetLines(model);

	assert.equal(lines[0], "EVALS // target repo");
	assert.match(lines[1], /Status running/);
	assert.match(lines[1], /Profile repo-project-ui/);
	assert.match(lines[1], /ctx 12%/);
	assert.match(lines[2], /Candidate 001 archived/);
	assert.deepEqual(renderEvalsActionLines(), [
		"Actions /quest evals status  |  /quest evals prepare  |  /quest evals analyze-community  |  /quest evals baseline  |  /quest evals run",
	]);
});

test("evals control items expose summary, eval, candidate, and live run details", () => {
	const state = {
		projectId: "project-ui",
		target: "repo",
		activeProfileId: "repo-project-ui",
		evalFamily: "frontierswe",
		evalDataset: "frontierswe-sample@v1",
		currentCandidateId: "001",
		frontierCandidateIds: ["001", "002"],
		status: "running",
		lastSummary: "Candidate 001 is running against the sample split.",
		updatedAt: 1712780000000,
	};

	const items = buildEvalsControlItems(state, "repo-project-ui", {
		role: "optimizer",
		phase: "search-eval",
		updatedAt: Date.now(),
		latestToolName: "quest_optimizer_set_profile",
		latestMessage: "Eval prep complete.",
	});

	assert.deepEqual(items.map((item) => item.value), ["summary", "eval", "candidate", "live-run"]);
	assert.match(items[0].detailMarkdown, /# Quest Evals/);
	assert.match(items[1].detailMarkdown, /# Eval/);
	assert.match(items[2].detailMarkdown, /Frontier ids: 001, 002/);
	assert.match(items[3].detailMarkdown, /# Live Optimizer Run/);
});

test("evals widget factory renders a single native widget with actions", () => {
	const model = buildEvalsWidgetModel(
		{
			projectId: "project-ui",
			target: "repo",
			activeProfileId: "repo-project-ui",
			evalFamily: "frontierswe",
			evalDataset: "frontierswe-sample@v1",
			currentCandidateId: "001",
			status: "running",
			lastSummary: "Candidate 001 archived. Leader 001 is active on frontierswe-sample@v1.",
			updatedAt: Date.now(),
		},
		"repo-project-ui",
		null,
	);
	const component = createEvalsWidgetComponent(model)({}, themeStub());
	const output = component.render(120).join("\n");

	assert.match(output, /EVALS \/\/ target repo/);
	assert.match(output, /Status running/);
	assert.match(output, /Actions \/quest evals status/);
});
