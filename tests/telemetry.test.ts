import { describe, expect, test } from "bun:test";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "../src/telemetry-core.js";

describe("worker telemetry", () => {
	test("tracks streaming text and tool execution progress", () => {
		let snapshot = createLiveRunSnapshot("worker", { featureId: "f1", milestoneId: "m1" });
		let events: ReturnType<typeof applyAgentEventToSnapshot>["events"] = [];

		({ snapshot, events } = applyAgentEventToSnapshot(
			snapshot,
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Planning the feature" },
			},
			60,
			events,
		));
		({ snapshot, events } = applyAgentEventToSnapshot(
			snapshot,
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "bun test" },
			},
			60,
			events,
		));
		({ snapshot, events } = applyAgentEventToSnapshot(
			snapshot,
			{
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "bun test" },
				partialResult: {
					content: [{ type: "text", text: "1 passed" }],
				},
			},
			60,
			events,
		));
		({ snapshot, events } = applyAgentEventToSnapshot(
			snapshot,
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "1 passed" }],
				},
				isError: false,
			},
			60,
			events,
		));

		expect(snapshot.phase).toBe("streaming");
		expect(snapshot.latestToolName).toBe("bash");
		expect(snapshot.latestToolSummary).toContain("1 passed");
		expect(snapshot.latestMessage).toContain("Planning the feature");
		expect(events.map((event) => event.type)).toEqual([
			"message_update",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
	});
});
