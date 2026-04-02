import { describe, expect, test } from "bun:test";
import { deriveLearnedWorkflows, mergeLearnedWorkflows } from "../src/workflows.js";

describe("learned workflows", () => {
	test("derives reusable workflow notes from validator evidence", () => {
		const workflows = deriveLearnedWorkflows({
			id: "run-1",
			role: "validator",
			milestoneId: "m1",
			startedAt: Date.now(),
			endedAt: Date.now(),
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
			exitCode: 1,
			ok: false,
			summary: "Validation failed because Docker was not running and bun db:push never completed.",
			issues: ["Browser validation depended on seeded data."],
			phase: "tool_error",
			latestToolName: "bash",
			latestToolSummary: "bun db:push",
			events: [
				{
					ts: Date.now(),
					type: "tool_execution_start",
					phase: "tool_running",
					toolName: "bash",
					summary: "docker compose up",
				},
			],
		});

		expect(workflows.map((workflow) => workflow.title)).toContain("Start Docker before quest checks");
		expect(workflows.map((workflow) => workflow.title)).toContain("Run database setup before app validation");
	});

	test("merges workflow notes by title", () => {
		const merged = mergeLearnedWorkflows(
			[
				{
					id: "wf-1",
					title: "Start Docker before quest checks",
					note: "Docker must be running.",
					source: "validator_failure",
					createdAt: 1,
					updatedAt: 1,
					evidence: ["docker missing"],
				},
			],
			[
				{
					id: "wf-2",
					title: "Start Docker before quest checks",
					note: "Ensure Docker Desktop is up before validation.",
					source: "worker_failure",
					createdAt: 2,
					updatedAt: 2,
					evidence: ["docker compose up failed"],
				},
			],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.evidence).toContain("docker missing");
		expect(merged[0]?.evidence).toContain("docker compose up failed");
	});
});
