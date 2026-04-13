import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	bashTool,
	createAgentSession,
	editTool,
	findTool,
	grepTool,
	lsTool,
	readTool,
	writeTool,
} from "@mariozechner/pi-coding-agent";
import { registerAgentRun, unregisterAgentRun } from "./agent-process-registry.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import type {
	QuestBenchmarkProvenance,
	LiveRunSnapshot,
	ModelChoice,
	QuestRole,
	WorkerEventRecord,
} from "./types.js";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunAgentTaskOptions {
	cwd: string;
	modelChoice: ModelChoice;
	tools: string[];
	role: QuestRole;
	featureId?: string;
	milestoneId?: string;
	systemPrompt?: string;
	prompt: string;
	benchmark?: QuestBenchmarkProvenance;
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

export interface RunAgentTaskResult {
	exitCode: number;
	sessionId: string;
	sessionFile?: string;
	messages: Message[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageStats;
	events: WorkerEventRecord[];
	phase: string;
	latestToolName?: string;
	latestToolSummary?: string;
	latestAssistantText?: string;
	signal?: string;
	aborted: boolean;
}

const DEFAULT_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

const BUILTIN_TOOLS = [readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool];
const RUNTIME_SESSION_DIR = join(".pi", "quests", "runtime-sessions");

export async function runAgentTask(options: RunAgentTaskOptions): Promise<RunAgentTaskResult> {
	const sessionDir = join(options.cwd, RUNTIME_SESSION_DIR);
	await mkdir(sessionDir, { recursive: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		appendSystemPromptOverride: (base) => (options.systemPrompt ? [...base, options.systemPrompt] : base),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		resourceLoader,
		sessionManager: SessionManager.create(options.cwd, sessionDir),
		tools: BUILTIN_TOOLS,
	});

	const resolvedModel = session.modelRegistry.find(options.modelChoice.provider, options.modelChoice.model);
	if (!resolvedModel) {
		session.dispose();
		throw new Error(`Unknown Pi model ${options.modelChoice.provider}/${options.modelChoice.model}.`);
	}

	await session.setModel(resolvedModel);
	session.setThinkingLevel(options.modelChoice.thinkingLevel);
	session.setActiveToolsByName(options.tools);

	const result: RunAgentTaskResult = {
		exitCode: 1,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		messages: [],
		stderr: "",
		usage: { ...DEFAULT_USAGE },
		events: [],
		phase: "starting",
		aborted: false,
	};

	let liveSnapshot = createLiveRunSnapshot(options.role, {
		featureId: options.featureId,
		milestoneId: options.milestoneId,
	});
	if (options.onSnapshot) await options.onSnapshot(liveSnapshot);

	const unsubscribe = session.subscribe((event: any) => {
		const nextTelemetry = applyAgentEventToSnapshot(liveSnapshot, event, 80, result.events);
		liveSnapshot = nextTelemetry.snapshot;
		result.events = nextTelemetry.events;
		result.phase = liveSnapshot.phase;
		result.latestToolName = liveSnapshot.latestToolName;
		result.latestToolSummary = liveSnapshot.latestToolSummary;
		result.latestAssistantText = liveSnapshot.latestMessage;

		if (
			options.onSnapshot &&
			["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end"].includes(event.type)
		) {
			void Promise.resolve(options.onSnapshot(liveSnapshot));
		}

		if (event.type === "message_end" && event.message) {
			const message = event.message as Message;
			result.messages.push(message);
			if ((message as any).role === "assistant") {
				result.usage.turns += 1;
				const usage = (message as any).usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
					result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
				}
				result.stopReason = (message as any).stopReason;
				result.errorMessage = (message as any).errorMessage;
				result.aborted = (message as any).stopReason === "aborted";
			}
		}

		if (event.type === "tool_result_end" && event.message) {
			result.messages.push(event.message as Message);
		}

		if (event.type === "agent_end" && Array.isArray(event.messages) && result.messages.length === 0) {
			result.messages = event.messages as Message[];
		}
	});

	let syntheticPid: number | undefined;
	try {
		syntheticPid = registerAgentRun(async () => {
			await session.abort();
		});
		if (options.onProcessStart) await options.onProcessStart(syntheticPid);
		await session.prompt(options.prompt, { source: "extension" as any });
		result.exitCode = result.errorMessage ? 1 : 0;
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result.stderr = error instanceof Error && error.stack ? error.stack : message;
		result.errorMessage = message;
		result.aborted ||= /abort/i.test(message);
		result.signal = result.aborted ? "SIGTERM" : undefined;
		result.exitCode = 1;
		return result;
	} finally {
		unregisterAgentRun(syntheticPid);
		unsubscribe();
		session.dispose();
	}
}
