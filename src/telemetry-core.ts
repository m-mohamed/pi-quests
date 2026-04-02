import type { LiveRunSnapshot, QuestRole, WorkerEventRecord } from "./types.js";

function truncate(text: string, max = 160): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}

function asText(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(" ");
	if (typeof value === "object") {
		const content = (value as { content?: unknown }).content;
		if (content) return asText(content);
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return "";
}

function summarizeArgs(args: any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	if (typeof args.command === "string") return truncate(args.command, 120);
	if (typeof args.cmd === "string") return truncate(args.cmd, 120);
	return truncate(JSON.stringify(args), 120);
}

function summarizePartialResult(partialResult: any): string | undefined {
	const contentText = asText(partialResult);
	return contentText ? truncate(contentText, 160) : undefined;
}

export function createLiveRunSnapshot(role: QuestRole, ids: { featureId?: string; milestoneId?: string }, phase = "starting"): LiveRunSnapshot {
	return {
		role,
		featureId: ids.featureId,
		milestoneId: ids.milestoneId,
		phase,
		updatedAt: Date.now(),
	};
}

export function applyAgentEventToSnapshot(
	current: LiveRunSnapshot,
	event: any,
	eventCap = 60,
	existingEvents: WorkerEventRecord[] = [],
): { snapshot: LiveRunSnapshot; events: WorkerEventRecord[] } {
	const next: LiveRunSnapshot = { ...current, updatedAt: Date.now() };
	const events = [...existingEvents];
	const pushEvent = (record: WorkerEventRecord) => {
		events.push(record);
		while (events.length > eventCap) events.shift();
	};

	switch (event?.type) {
		case "message_update": {
			const assistantEvent = event.assistantMessageEvent;
			const updateType = assistantEvent?.type;
			if (updateType === "text_delta") {
				next.phase = "streaming";
				next.latestMessage = truncate(`${next.latestMessage || ""}${assistantEvent.delta || ""}`, 180);
				pushEvent({
					ts: Date.now(),
					type: "message_update",
					phase: next.phase,
					summary: truncate(String(assistantEvent.delta || ""), 120),
				});
			} else if (updateType === "thinking_delta") {
				next.phase = "thinking";
				pushEvent({
					ts: Date.now(),
					type: "message_update",
					phase: next.phase,
					summary: "thinking",
				});
			} else if (updateType === "toolcall_start" || updateType === "toolcall_delta" || updateType === "toolcall_end") {
				next.phase = "tool_planning";
				pushEvent({
					ts: Date.now(),
					type: "message_update",
					phase: next.phase,
					summary: updateType,
				});
			}
			break;
		}

		case "tool_execution_start": {
			next.phase = "tool_running";
			next.latestToolName = event.toolName;
			next.latestToolSummary = summarizeArgs(event.args) || event.toolName;
			pushEvent({
				ts: Date.now(),
				type: "tool_execution_start",
				phase: next.phase,
				summary: next.latestToolSummary,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
			});
			break;
		}

		case "tool_execution_update": {
			next.phase = "tool_running";
			next.latestToolName = event.toolName;
			next.latestToolSummary = summarizePartialResult(event.partialResult) || summarizeArgs(event.args) || next.latestToolSummary;
			pushEvent({
				ts: Date.now(),
				type: "tool_execution_update",
				phase: next.phase,
				summary: next.latestToolSummary,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
			});
			break;
		}

		case "tool_execution_end": {
			next.phase = event.isError ? "tool_error" : "streaming";
			next.latestToolName = event.toolName;
			next.latestToolSummary = summarizePartialResult(event.result) || next.latestToolSummary || event.toolName;
			pushEvent({
				ts: Date.now(),
				type: "tool_execution_end",
				phase: next.phase,
				summary: next.latestToolSummary,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: Boolean(event.isError),
			});
			break;
		}

		case "turn_end": {
			next.phase = "turn_complete";
			const text = asText(event.message?.content);
			if (text) next.latestMessage = truncate(text, 180);
			pushEvent({
				ts: Date.now(),
				type: "turn_end",
				phase: next.phase,
				summary: next.latestMessage || "turn_complete",
			});
			break;
		}

		case "agent_end": {
			next.phase = "completed";
			pushEvent({
				ts: Date.now(),
				type: "agent_end",
				phase: next.phase,
				summary: "agent_end",
			});
			break;
		}
	}

	return { snapshot: next, events };
}
