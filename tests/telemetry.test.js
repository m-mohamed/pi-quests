import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "../src/telemetry-core.js";

test("tracks streaming text and tool execution progress", () => {
	let snapshot = createLiveRunSnapshot("worker", { featureId: "f1", milestoneId: "m1" });
	let events = [];

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
			args: { command: "npm test" },
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
			args: { command: "npm test" },
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

	assert.equal(snapshot.phase, "streaming");
	assert.equal(snapshot.latestToolName, "bash");
	assert.match(snapshot.latestToolSummary ?? "", /1 passed/);
	assert.match(snapshot.latestMessage ?? "", /Planning the feature/);
	assert.deepEqual(
		events.map((event) => event.type),
		["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"],
	);
});
