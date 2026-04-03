import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { parseQuestPlanText, revisionInstructions } from "./plan-core.js";
import { applyAgentEventToSnapshot, createLiveRunSnapshot } from "./telemetry-core.js";
import type {
	LearnedWorkflow,
	LiveRunSnapshot,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestState,
	ModelChoice,
	ThinkingLevel,
	WorkerEventRecord,
	WorkerRunRecord,
} from "./types.js";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RunPiTaskOptions {
	cwd: string;
	modelChoice: ModelChoice;
	tools: string[];
	role: "orchestrator" | "worker" | "validator";
	featureId?: string;
	milestoneId?: string;
	systemPrompt?: string;
	prompt: string;
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>;
	onProcessStart?: (pid: number) => void | Promise<void>;
}

interface RunPiTaskResult {
	exitCode: number;
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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript) return { command: process.execPath, args: [currentScript, ...args] };
	return { command: "pi", args };
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function extractJsonBlock<T>(text: string): T | null {
	const fenced = text.match(/```json\s*([\s\S]*?)```/i);
	if (!fenced) return null;
	try {
		return JSON.parse(fenced[1]) as T;
	} catch {
		return null;
	}
}

async function withTempPrompt(contents: string | undefined): Promise<{ file?: string; cleanup: () => Promise<void> }> {
	if (!contents?.trim()) return { cleanup: async () => {} };

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-quests-"));
	const file = path.join(dir, "system.md");
	await fs.writeFile(file, contents, "utf-8");
	return {
		file,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function learnedWorkflowSection(workflows: LearnedWorkflow[]): string {
	if (workflows.length === 0) return "- None";
	return workflows.map((workflow) => `- ${workflow.title}: ${workflow.note}`).join("\n");
}

function validationCriteriaForFeature(quest: QuestState, feature: QuestFeature) {
	return quest.plan?.validationContract.criteria.filter((criterion) => criterion.featureIds.includes(feature.id)) ?? [];
}

function validationCriteriaForMilestone(quest: QuestState, milestone: QuestMilestone) {
	return quest.plan?.validationContract.criteria.filter((criterion) => criterion.milestoneId === milestone.id) ?? [];
}

function questContext(quest: QuestState, workflows: LearnedWorkflow[]): string {
	const criteria = quest.plan?.successCriteria.length
		? quest.plan.successCriteria.map((item) => `- ${item}`).join("\n")
		: "- Deliver the requested work cleanly.";
	const notes = quest.steeringNotes.length ? quest.steeringNotes.map((note) => `- ${note}`).join("\n") : "- None";
	return `Quest: ${quest.plan?.title ?? quest.title}

Goal:
${quest.goal}

Quest summary:
${quest.plan?.summary ?? quest.lastSummary ?? "No summary yet."}

Success criteria:
${criteria}

Steering notes:
${notes}

Project learned workflows:
${learnedWorkflowSection(workflows)}`;
}

export function buildFeaturePrompt(quest: QuestState, feature: QuestFeature, milestone: QuestMilestone, workflows: LearnedWorkflow[]): string {
	const criteria = feature.acceptanceCriteria.length
		? feature.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
		: "- Complete the feature cleanly.";
	const validation = validationCriteriaForFeature(quest, feature);
	const validationLines =
		validation.length > 0
			? validation
					.map(
						(criterion) =>
							`- ${criterion.title} (${criterion.proofStrategy}, ${criterion.confidence})\n  Proof: ${criterion.proofDetails}${
								criterion.commands.length > 0 ? `\n  Commands: ${criterion.commands.join(", ")}` : ""
							}`,
					)
					.join("\n")
			: "- No feature-specific validation contract was captured.";

	return `${questContext(quest, workflows)}

Current milestone: ${milestone.title}
Milestone summary: ${milestone.summary}

Assigned feature: ${feature.title}
Feature summary: ${feature.summary}

Acceptance criteria:
${criteria}

Validation contract for this feature:
${validationLines}

${feature.workerPrompt ? `Feature-specific instructions:\n${feature.workerPrompt}\n` : ""}

Execute only this feature. Keep the quest serial and scoped. Do not introduce unrelated changes. Do not start or manage quests.

At the end, output:
## Feature Result
- summary
- files touched
- follow-ups if any

\`\`\`json
{
  "status": "completed",
  "summary": "what you completed",
  "filesTouched": ["optional/path"],
  "followUps": ["optional follow-up"]
}
\`\`\`
`;
}

export function buildWorkerSystemPrompt(): string {
	return `You are a quest worker executing a single feature within a larger Pi quest.

Rules:
- Focus only on the assigned feature.
- Follow the repo's conventions and existing instructions.
- Make the smallest correct change that satisfies the feature.
- Do not start new quests or inspect quest internals.
- Do not rewrite unrelated parts of the codebase.
- Respect the validation contract.
- End with the required JSON block.`;
}

export function buildValidatorPrompt(quest: QuestState, milestone: QuestMilestone, features: QuestFeature[], workflows: LearnedWorkflow[]): string {
	const featureList = features.map((feature) => `- ${feature.title}: ${feature.lastRunSummary ?? feature.summary}`).join("\n");
	const criteria = milestone.successCriteria.length
		? milestone.successCriteria.map((item) => `- ${item}`).join("\n")
		: "- Confirm the milestone is stable.";
	const validation = validationCriteriaForMilestone(quest, milestone);
	const validationLines =
		validation.length > 0
			? validation
					.map(
						(criterion) =>
							`- ${criterion.title} (${criterion.proofStrategy}, ${criterion.confidence})\n  Behavior: ${criterion.expectedBehavior}\n  Proof: ${criterion.proofDetails}${
								criterion.commands.length > 0 ? `\n  Commands: ${criterion.commands.join(", ")}` : ""
							}`,
					)
					.join("\n")
			: "- No milestone-specific validation contract was captured.";
	const weakWarnings = quest.plan?.validationContract.weakValidationWarnings.length
		? quest.plan.validationContract.weakValidationWarnings.map((warning) => `- ${warning}`).join("\n")
		: "- None.";

	return `${questContext(quest, workflows)}

Validate the milestone "${milestone.title}".

Features completed in this milestone:
${featureList}

Milestone success criteria:
${criteria}

Validation contract for this milestone:
${validationLines}

Known weak validation areas:
${weakWarnings}

${milestone.validationPrompt ? `Extra validation guidance:\n${milestone.validationPrompt}\n` : ""}

You are read-only. Verify the milestone by reading files and running checks. Do not edit code.

At the end, output:
\`\`\`json
{
  "status": "pass",
  "summary": "validation result",
  "issues": []
}
\`\`\`
`;
}

export function buildValidatorSystemPrompt(): string {
	return `You are a read-only quest validator.

Rules:
- Verify the assigned milestone using read-only tools and commands.
- Do not edit or write files.
- Be explicit about any issues, blockers, or weak validation.
- End with the required JSON block.`;
}

export function buildPlanRevisionSystemPrompt(): string {
	return `You are the quest orchestrator revising only the remaining plan for an existing Pi quest.

Rules:
- Preserve completed work.
- Only change unfinished milestones, unfinished features, and validation for unfinished work.
- Keep the quest serial by default.
- Do not edit repository files.
- End with the required JSON block.`;
}

async function runPiTask(options: RunPiTaskOptions): Promise<RunPiTaskResult> {
	const temp = await withTempPrompt(options.systemPrompt);
	const args = ["--mode", "json", "--no-session", "--model", `${options.modelChoice.provider}/${options.modelChoice.model}`];
	args.push("--thinking", options.modelChoice.thinkingLevel as ThinkingLevel);
	if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (temp.file) args.push("--append-system-prompt", temp.file);
	args.push("-p", options.prompt);

	const result: RunPiTaskResult = {
		exitCode: 1,
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

	try {
		const invocation = getPiInvocation(args);
		await new Promise<void>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			if (typeof proc.pid === "number" && options.onProcessStart) {
				void Promise.resolve(options.onProcessStart(proc.pid));
			}

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const nextTelemetry = applyAgentEventToSnapshot(liveSnapshot, event, 80, result.events);
				liveSnapshot = nextTelemetry.snapshot;
				result.events = nextTelemetry.events;
				result.phase = liveSnapshot.phase;
				result.latestToolName = liveSnapshot.latestToolName;
				result.latestToolSummary = liveSnapshot.latestToolSummary;
				result.latestAssistantText = liveSnapshot.latestMessage;
				if (options.onSnapshot && ["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end"].includes(event.type)) {
					void Promise.resolve(options.onSnapshot(liveSnapshot));
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns += 1;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
						}
						result.stopReason = msg.stopReason;
						result.errorMessage = msg.errorMessage;
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
				}

				if (event.type === "agent_end" && Array.isArray(event.messages) && result.messages.length === 0) {
					result.messages = event.messages as Message[];
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = code ?? 0;
				result.signal = signal ?? undefined;
				result.aborted = signal === "SIGTERM" || signal === "SIGKILL";
				resolve();
			});

			proc.on("error", (err) => {
				result.stderr += `${err}`;
				result.exitCode = 1;
				resolve();
			});
		});

		return result;
	} finally {
		await temp.cleanup();
	}
}

export async function executeFeatureWorker(
	quest: QuestState,
	feature: QuestFeature,
	milestone: QuestMilestone,
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: ["read", "bash", "edit", "write"],
		role: "worker",
		featureId: feature.id,
		milestoneId: milestone.id,
		systemPrompt: buildWorkerSystemPrompt(),
		prompt: buildFeaturePrompt(quest, feature, milestone, workflows),
		onSnapshot,
		onProcessStart,
	});

	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<{ status?: string; summary?: string }>(text);
	const ok = result.exitCode === 0 && parsed?.status !== "failed" && parsed?.status !== "blocked";

	return {
		id: randomUUID(),
		role: "worker",
		featureId: feature.id,
		milestoneId: milestone.id,
		startedAt,
		endedAt: Date.now(),
		provider: modelChoice.provider,
		model: modelChoice.model,
		thinkingLevel: modelChoice.thinkingLevel,
		exitCode: result.exitCode,
		ok,
		summary: parsed?.summary || text || "No worker summary returned.",
		stopReason: result.stopReason,
		stderr: result.stderr || undefined,
		aborted: result.aborted,
		signal: result.signal,
		phase: result.phase,
		latestToolName: result.latestToolName,
		latestToolSummary: result.latestToolSummary,
		latestAssistantText: result.latestAssistantText,
		events: result.events,
		usage: result.usage,
	};
}

export async function executeValidator(
	quest: QuestState,
	milestone: QuestMilestone,
	features: QuestFeature[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: ["read", "bash"],
		role: "validator",
		milestoneId: milestone.id,
		systemPrompt: buildValidatorSystemPrompt(),
		prompt: buildValidatorPrompt(quest, milestone, features, workflows),
		onSnapshot,
		onProcessStart,
	});

	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<{ status?: string; summary?: string; issues?: string[] }>(text);
	const issues = parsed?.issues ?? [];
	const ok = result.exitCode === 0 && parsed?.status !== "fail";

	return {
		id: randomUUID(),
		role: "validator",
		milestoneId: milestone.id,
		startedAt,
		endedAt: Date.now(),
		provider: modelChoice.provider,
		model: modelChoice.model,
		thinkingLevel: modelChoice.thinkingLevel,
		exitCode: result.exitCode,
		ok,
		summary: parsed?.summary || text || "No validator summary returned.",
		stopReason: result.stopReason,
		stderr: result.stderr || undefined,
		issues,
		aborted: result.aborted,
		signal: result.signal,
		phase: result.phase,
		latestToolName: result.latestToolName,
		latestToolSummary: result.latestToolSummary,
		latestAssistantText: result.latestAssistantText,
		events: result.events,
		usage: result.usage,
	};
}

export async function executePlanRevision(
	quest: QuestState,
	requests: QuestPlanRevisionRequest[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; revisedPlan: QuestPlan | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: ["read", "bash"],
		role: "orchestrator",
		systemPrompt: buildPlanRevisionSystemPrompt(),
		prompt: revisionInstructions(quest, requests, workflows),
		onSnapshot,
		onProcessStart,
	});

	const text = getFinalAssistantText(result.messages);
	const revisedPlan = parseQuestPlanText(text)?.plan ?? null;
	const ok = result.exitCode === 0 && Boolean(revisedPlan);

	return {
		revisedPlan,
		run: {
			id: randomUUID(),
			role: "orchestrator",
			startedAt,
			endedAt: Date.now(),
			provider: modelChoice.provider,
			model: modelChoice.model,
			thinkingLevel: modelChoice.thinkingLevel,
			exitCode: result.exitCode,
			ok,
			summary: revisedPlan ? "Revised remaining quest plan." : text || "No plan revision returned.",
			stopReason: result.stopReason,
			stderr: result.stderr || undefined,
			aborted: result.aborted,
			signal: result.signal,
			phase: result.phase,
			latestToolName: result.latestToolName,
			latestToolSummary: result.latestToolSummary,
			latestAssistantText: result.latestAssistantText,
			events: result.events,
			usage: result.usage,
		},
	};
}
