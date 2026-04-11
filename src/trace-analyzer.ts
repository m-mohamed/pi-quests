import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deriveIssuesFromTags } from "./profile-core.js";
import { getQuestTrialPaths } from "./state-core.js";
import { compact } from "./utils.js";
import type {
	CommunitySourceStats,
	CommunityStats,
	PiCompactionEvent,
	PiMessageContentBlock,
	PiMessageEvent,
	PiModelChangeEvent,
	PiSessionEvent,
	PiSessionInfoEvent,
	PiSessionStartEvent,
	PiSessionTrace,
	PiThinkingLevelChangeEvent,
	QuestFailureTag,
	ThinkingLevel,
} from "./types.js";

interface ParsedCommunityTrace {
	trace: PiSessionTrace;
	toolNameCounts: Record<string, number>;
	providerCounts: Record<string, number>;
	modelCounts: Record<string, number>;
}

function recordCount(target: Record<string, number>, key: string | undefined, count = 1): void {
	if (!key) return;
	target[key] = (target[key] ?? 0) + count;
}

function parseTimestamp(value: string | undefined): number {
	if (!value) return Date.now();
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function durationBucket(durationMs: number): string {
	if (durationMs < 60_000) return "<1m";
	if (durationMs < 5 * 60_000) return "1-5m";
	if (durationMs < 15 * 60_000) return "5-15m";
	if (durationMs < 60 * 60_000) return "15-60m";
	return "60m+";
}

function collectContentText(blocks: PiMessageContentBlock[] | undefined): string {
	if (!blocks?.length) return "";
	return compact(
		blocks
			.map((block) => {
				if (block.type === "text") return String(block.text ?? "");
				if (block.type === "thinking") return String(block.thinking ?? "");
				if (block.type === "toolCall") {
					const args =
						typeof block.arguments === "string" ? block.arguments : block.arguments ? JSON.stringify(block.arguments) : "";
					return `${block.name ?? ""} ${args}`.trim();
				}
				return "";
			})
			.filter(Boolean)
			.join(" "),
	);
}

function sessionStartFromEvent(event: PiSessionEvent, sourcePath: string): PiSessionStartEvent {
	if (event.type !== "session") {
		throw new Error(`Expected first record to be a session event in ${sourcePath}`);
	}
	return event as PiSessionStartEvent;
}

function isMessageEvent(event: PiSessionEvent): event is PiMessageEvent {
	return event.type === "message" && typeof event.message === "object" && event.message !== null;
}

function isModelChangeEvent(event: PiSessionEvent): event is PiModelChangeEvent {
	return event.type === "model_change";
}

function isThinkingLevelChangeEvent(event: PiSessionEvent): event is PiThinkingLevelChangeEvent {
	return event.type === "thinking_level_change";
}

function isCompactionEvent(event: PiSessionEvent): event is PiCompactionEvent {
	return event.type === "compaction";
}

function isSessionInfoEvent(event: PiSessionEvent): event is PiSessionInfoEvent {
	return event.type === "session_info";
}

function collectSerializedText(events: PiSessionEvent[]): string {
	return compact(
		events
			.map((event) => {
				if (isMessageEvent(event)) return collectContentText(event.message.content);
				if (isSessionInfoEvent(event)) return `${event.name ?? ""} ${JSON.stringify(event.config ?? {})}`.trim();
				if (isCompactionEvent(event)) return `${event.summary ?? ""} ${JSON.stringify(event.details ?? {})}`.trim();
				return JSON.stringify(event);
			})
			.filter(Boolean)
			.join(" "),
	);
}

export function deriveCommunityFailureTags(trace: PiSessionTrace): QuestFailureTag[] {
	const serialized = collectSerializedText(trace.events).toLowerCase();
	const tags = new Set<QuestFailureTag>();
	const repeatedToolPressure = trace.toolCallCount >= 8;
	const repeatedCorrectivePatterns =
		/(try again|retry|re-run|rerun|another attempt|let me try|i'll try|failed again|still failing)/.test(serialized) ||
		repeatedToolPressure;

	if (/(prerequisite|not installed|not configured|command not found|enable kubernetes|start docker|set up|missing dependency|connection refused)/.test(serialized)) {
		tags.add("prerequisite_miss");
	}
	if (/(limited|unsupported|manual|human qa|can't verify|cannot verify|unable to verify|dry-run)/.test(serialized)) {
		tags.add("weak_validation");
	}
	if (/(blocked|cannot continue|can't continue|stuck|unable to proceed|refused|timed out)/.test(serialized)) {
		tags.add("blocked_milestone");
	}
	if (repeatedCorrectivePatterns) {
		tags.add("repeated_corrective_loop");
	}
	if (/(abort|aborted|cancelled|canceled|interrupted by user)/.test(serialized)) {
		tags.add("operator_abort");
	}
	if (trace.compactions.length > 0 || /(context overflow|context window|max tokens|too many tokens|prompt is too long)/.test(serialized)) {
		tags.add("context_overflow");
	}
	if (trace.toolCallCount >= 6) {
		tags.add("tool_heavy");
	}
	if (trace.errorCount > 0 || /(command exited with code|traceback|exception|error:|failed)/.test(serialized)) {
		tags.add("worker_failure");
	}
	if (trace.modelChanges.length > 0 && tags.has("worker_failure")) {
		tags.add("model_mismatch_suspected");
	}

	return [...tags];
}

export async function discoverCommunityTraceFiles(rootDir: string): Promise<string[]> {
	if (!existsSync(rootDir)) return [];
	const discovered: string[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) discovered.push(entryPath);
		}
	}

	await walk(rootDir);
	return discovered.sort((left, right) => left.localeCompare(right));
}

export async function parseSessionJsonl(sourcePath: string): Promise<ParsedCommunityTrace | null> {
	const raw = await readFile(sourcePath, "utf-8");
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;

	const firstEvent = JSON.parse(lines[0]) as PiSessionEvent;
	if (firstEvent.type !== "session") return null;

	const sessionEvent = sessionStartFromEvent(firstEvent, sourcePath);
	const events: PiSessionEvent[] = [];
	const modelChanges: PiSessionTrace["modelChanges"] = [];
	const thinkingLevelChanges: PiSessionTrace["thinkingLevelChanges"] = [];
	const compactions: PiSessionTrace["compactions"] = [];
	const toolNameCounts: Record<string, number> = {};
	const providerCounts: Record<string, number> = {};
	const modelCounts: Record<string, number> = {};
	let messageCount = 0;
	let toolCallCount = 0;
	let errorCount = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let turnCount = 0;
	let startedAt = parseTimestamp(sessionEvent.timestamp);
	let endedAt = startedAt;
	let currentProvider = typeof sessionEvent.provider === "string" ? sessionEvent.provider : undefined;
	let currentModel = typeof sessionEvent.modelId === "string" ? sessionEvent.modelId : undefined;
	let currentThinkingLevel: ThinkingLevel | undefined =
		typeof sessionEvent.thinkingLevel === "string" ? (sessionEvent.thinkingLevel as ThinkingLevel) : undefined;

	recordCount(providerCounts, currentProvider);
	recordCount(modelCounts, currentModel);

	for (const line of lines) {
		const event = JSON.parse(line) as PiSessionEvent;
		events.push(event);
		const timestamp = parseTimestamp(event.timestamp);
		startedAt = Math.min(startedAt, timestamp);
		endedAt = Math.max(endedAt, timestamp);

		if (isModelChangeEvent(event)) {
			currentProvider = event.provider;
			currentModel = event.modelId;
			modelChanges.push({ provider: event.provider, modelId: event.modelId, timestamp: event.timestamp });
			recordCount(providerCounts, event.provider);
			recordCount(modelCounts, event.modelId);
			continue;
		}

		if (isThinkingLevelChangeEvent(event)) {
			currentThinkingLevel = event.thinkingLevel;
			thinkingLevelChanges.push({ thinkingLevel: event.thinkingLevel, timestamp: event.timestamp });
			continue;
		}

		if (isCompactionEvent(event)) {
			compactions.push({
				timestamp: event.timestamp,
				summary: event.summary,
				firstKeptEntryId: event.firstKeptEntryId,
				tokensBefore: event.tokensBefore ?? event.originalTokens,
				tokensAfter: event.tokensAfter ?? event.compactedTokens,
				fromHook: event.fromHook,
				details: event.details,
			});
			continue;
		}

		if (!isMessageEvent(event)) continue;
		messageCount += 1;
		if (event.message.provider) {
			currentProvider = event.message.provider;
			recordCount(providerCounts, event.message.provider);
		}
		if (event.message.model) {
			currentModel = event.message.model;
			recordCount(modelCounts, event.message.model);
		}
		if (event.message.role === "assistant" && event.message.usage) {
			totalInputTokens += event.message.usage.input;
			totalOutputTokens += event.message.usage.output;
			totalCacheRead += event.message.usage.cacheRead;
			totalCacheWrite += event.message.usage.cacheWrite;
			totalCost += event.message.usage.cost.total;
			turnCount += 1;
		}
		if (event.message.role === "toolResult" && event.message.isError) {
			errorCount += 1;
		}
		for (const block of event.message.content ?? []) {
			if (block.type !== "toolCall") continue;
			toolCallCount += 1;
			recordCount(toolNameCounts, block.name);
		}
	}

	const trace: PiSessionTrace = {
		id: sessionEvent.id ?? basename(sourcePath).replace(/\.jsonl$/i, ""),
		sourcePath,
		version: sessionEvent.version,
		cwd: sessionEvent.cwd,
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		events,
		modelChanges,
		thinkingLevelChanges,
		compactions,
		messageCount,
		toolCallCount,
		errorCount,
		usage: {
			totalInputTokens,
			totalOutputTokens,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			turnCount,
		},
		derivedTags: [],
		derivedIssues: [],
	};

	trace.derivedTags = deriveCommunityFailureTags(trace);
	trace.derivedIssues = deriveIssuesFromTags(trace.derivedTags);

	if (currentProvider) recordCount(providerCounts, currentProvider, 0);
	if (currentModel) recordCount(modelCounts, currentModel, 0);
	if (currentThinkingLevel) {
		// Preserve current thinking level discovery through the parsed trace, even if unused downstream.
		trace.thinkingLevelChanges = trace.thinkingLevelChanges.length > 0 ? trace.thinkingLevelChanges : [{ thinkingLevel: currentThinkingLevel, timestamp: sessionEvent.timestamp }];
	}

	return {
		trace,
		toolNameCounts,
		providerCounts,
		modelCounts,
	};
}

function createEmptySourceStats(sourceId: string): CommunitySourceStats {
	return {
		sourceId,
		sessionCount: 0,
		parsedSessions: 0,
		failedSessions: 0,
		failedPaths: [],
		models: {},
		providers: {},
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		totalDurationMs: 0,
		totalToolCalls: 0,
		totalErrors: 0,
		totalMessages: 0,
		failureTags: {},
	};
}

function sourceIdFor(rootDir: string, filePath: string): string {
	const normalizedRoot = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
	const relativePath = filePath.startsWith(normalizedRoot) ? filePath.slice(normalizedRoot.length) : filePath;
	return dirname(relativePath).replaceAll("\\", "/");
}

function addTraceToSourceStats(target: CommunitySourceStats, parsed: ParsedCommunityTrace): void {
	target.parsedSessions += 1;
	target.totalInputTokens += parsed.trace.usage.totalInputTokens;
	target.totalOutputTokens += parsed.trace.usage.totalOutputTokens;
	target.totalCacheRead += parsed.trace.usage.totalCacheRead;
	target.totalCacheWrite += parsed.trace.usage.totalCacheWrite;
	target.totalCost += parsed.trace.usage.totalCost;
	target.totalDurationMs += parsed.trace.durationMs;
	target.totalToolCalls += parsed.trace.toolCallCount;
	target.totalErrors += parsed.trace.errorCount;
	target.totalMessages += parsed.trace.messageCount;
	for (const tag of parsed.trace.derivedTags) {
		target.failureTags[tag] = (target.failureTags[tag] ?? 0) + 1;
	}
	for (const [provider, count] of Object.entries(parsed.providerCounts)) recordCount(target.providers, provider, count);
	for (const [model, count] of Object.entries(parsed.modelCounts)) recordCount(target.models, model, count);
}

export async function analyzeCommunityTraces(rootDir: string): Promise<CommunityStats> {
	const files = await discoverCommunityTraceFiles(rootDir);
	const stats: CommunityStats = {
		generatedAt: Date.now(),
		totalFiles: files.length,
		totalSessions: 0,
		parsedSessions: 0,
		failedSessions: 0,
		failedPaths: [],
		sources: {},
		models: {},
		providers: {},
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		avgDurationMs: 0,
		avgToolCalls: 0,
		avgErrors: 0,
		avgMessages: 0,
		failureTags: {},
		topToolNames: {},
		sessionDurationBuckets: [
			{ label: "<1m", count: 0 },
			{ label: "1-5m", count: 0 },
			{ label: "5-15m", count: 0 },
			{ label: "15-60m", count: 0 },
			{ label: "60m+", count: 0 },
		],
	};

	if (files.length === 0) return stats;

	for (const filePath of files) {
		const sourceId = sourceIdFor(rootDir, filePath);
		let firstLine = "";
		try {
			firstLine = (await readFile(filePath, "utf-8")).split(/\r?\n/, 1)[0]?.trim() ?? "";
		} catch (error) {
			stats.sources[sourceId] ??= createEmptySourceStats(sourceId);
			stats.failedSessions += 1;
			stats.failedPaths.push(filePath);
			stats.sources[sourceId].failedSessions += 1;
			stats.sources[sourceId].failedPaths.push(filePath);
			continue;
		}
		let firstRecord: PiSessionEvent | null = null;
		try {
			firstRecord = firstLine ? (JSON.parse(firstLine) as PiSessionEvent) : null;
		} catch {
			stats.sources[sourceId] ??= createEmptySourceStats(sourceId);
			stats.failedSessions += 1;
			stats.failedPaths.push(filePath);
			stats.sources[sourceId].failedSessions += 1;
			stats.sources[sourceId].failedPaths.push(filePath);
			continue;
		}
		if (firstRecord?.type !== "session") continue;
		stats.sources[sourceId] ??= createEmptySourceStats(sourceId);
		stats.totalSessions += 1;
		stats.sources[sourceId].sessionCount += 1;

		try {
			const parsed = await parseSessionJsonl(filePath);
			if (!parsed) continue;
			stats.parsedSessions += 1;
			addTraceToSourceStats(stats.sources[sourceId], parsed);
			stats.totalInputTokens += parsed.trace.usage.totalInputTokens;
			stats.totalOutputTokens += parsed.trace.usage.totalOutputTokens;
			stats.totalCacheRead += parsed.trace.usage.totalCacheRead;
			stats.totalCacheWrite += parsed.trace.usage.totalCacheWrite;
			stats.totalCost += parsed.trace.usage.totalCost;
			for (const tag of parsed.trace.derivedTags) {
				stats.failureTags[tag] = (stats.failureTags[tag] ?? 0) + 1;
			}
			for (const [toolName, count] of Object.entries(parsed.toolNameCounts)) recordCount(stats.topToolNames, toolName, count);
			for (const [provider, count] of Object.entries(parsed.providerCounts)) recordCount(stats.providers, provider, count);
			for (const [model, count] of Object.entries(parsed.modelCounts)) recordCount(stats.models, model, count);
			const bucket = durationBucket(parsed.trace.durationMs);
			const bucketStats = stats.sessionDurationBuckets.find((entry) => entry.label === bucket);
			if (bucketStats) bucketStats.count += 1;
		} catch {
			stats.failedSessions += 1;
			stats.failedPaths.push(filePath);
			stats.sources[sourceId].failedSessions += 1;
			stats.sources[sourceId].failedPaths.push(filePath);
		}
	}

	const divisor = stats.parsedSessions || 1;
	const totalDurationMs = Object.values(stats.sources).reduce((total, source) => total + source.totalDurationMs, 0);
	const totalToolCalls = Object.values(stats.sources).reduce((total, source) => total + source.totalToolCalls, 0);
	const totalErrors = Object.values(stats.sources).reduce((total, source) => total + source.totalErrors, 0);
	const totalMessages = Object.values(stats.sources).reduce((total, source) => total + source.totalMessages, 0);
	stats.avgDurationMs = totalDurationMs / divisor;
	stats.avgToolCalls = totalToolCalls / divisor;
	stats.avgErrors = totalErrors / divisor;
	stats.avgMessages = totalMessages / divisor;

	return stats;
}

export async function writeCommunityStats(cwd: string, stats: CommunityStats): Promise<string> {
	const paths = getQuestTrialPaths(cwd);
	await writeFile(paths.communityStatsFile, `${JSON.stringify(stats, null, 2)}\n`, "utf-8");
	return paths.communityStatsFile;
}

export async function loadCommunityStats(cwd: string): Promise<CommunityStats | null> {
	const paths = getQuestTrialPaths(cwd);
	if (!existsSync(paths.communityStatsFile)) return null;
	try {
		const raw = await readFile(paths.communityStatsFile, "utf-8");
		return JSON.parse(raw) as CommunityStats;
	} catch {
		return null;
	}
}
