import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeCommunityTraces, parseSessionJsonl } from "../src/trace-analyzer.js";

async function writeJsonl(file, records) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}

test("parseSessionJsonl handles Pi-native message, thinking-level, and compaction shapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-quests-trace-parse-"));
	try {
		const file = join(root, "alice", "repo", "session.jsonl");
		await mkdir(join(root, "alice", "repo"), { recursive: true });
		await writeJsonl(file, [
			{
				type: "session",
				id: "session-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace/repo",
				provider: "anthropic",
				modelId: "claude-opus",
				thinkingLevel: "off",
			},
			{
				type: "thinking_level_change",
				timestamp: "2026-01-01T00:00:01.000Z",
				thinkingLevel: "high",
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "npm test" },
						},
					],
					usage: {
						input: 10,
						output: 20,
						cacheRead: 1,
						cacheWrite: 2,
						totalTokens: 33,
						cost: {
							input: 0.1,
							output: 0.2,
							cacheRead: 0.01,
							cacheWrite: 0.02,
							total: 0.33,
						},
					},
				},
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Command exited with code 1" }],
				},
			},
			{
				type: "compaction",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: "Context window pressure",
				firstKeptEntryId: "m3",
				tokensBefore: 1000,
				tokensAfter: 400,
				fromHook: true,
				details: { reason: "max tokens" },
			},
		]);

		const parsed = await parseSessionJsonl(file);
		assert.ok(parsed);
		assert.equal(parsed.trace.id, "session-1");
		assert.equal(parsed.trace.usage.totalCost, 0.33);
		assert.equal(parsed.trace.toolCallCount, 1);
		assert.equal(parsed.trace.errorCount, 1);
		assert.equal(parsed.trace.compactions[0].tokensBefore, 1000);
		assert.equal(parsed.trace.thinkingLevelChanges[0].thinkingLevel, "high");
		assert.ok(parsed.trace.derivedTags.includes("context_overflow"));
		assert.ok(parsed.trace.derivedTags.includes("worker_failure"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("analyzeCommunityTraces excludes non-session files and aggregates per-source stats", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-quests-trace-analyze-"));
	try {
		const sourceADir = join(root, "alice", "repo-a");
		const sourceBDir = join(root, "bob", "repo-b");
		const sourceCDir = join(root, "cfahlgren1", "agent-sessions-list", "sessions", "claude");
		await mkdir(sourceADir, { recursive: true });
		await mkdir(sourceBDir, { recursive: true });
		await mkdir(sourceCDir, { recursive: true });

		await writeJsonl(join(sourceADir, "manifest.jsonl"), [{ type: "manifest", timestamp: "2026-01-01T00:00:00.000Z" }]);
		await writeJsonl(join(sourceCDir, "manifest.jsonl"), [{ type: "manifest", timestamp: "2026-01-01T00:00:00.000Z" }]);
		await writeJsonl(join(sourceADir, "session-a.jsonl"), [
			{
				type: "session",
				id: "session-a",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace/a",
				provider: "anthropic",
				modelId: "claude-opus",
				thinkingLevel: "off",
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus",
					content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
					usage: {
						input: 5,
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 12,
						cost: { input: 0.05, output: 0.07, cacheRead: 0, cacheWrite: 0, total: 0.12 },
					},
				},
			},
		]);
		await writeJsonl(join(sourceBDir, "session-b.jsonl"), [
			{
				type: "session",
				id: "session-b",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/workspace/b",
				provider: "openai",
				modelId: "gpt-5.4",
				thinkingLevel: "high",
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-5.4",
					content: [{ type: "text", text: "manual validation still required" }],
					usage: {
						input: 3,
						output: 4,
						cacheRead: 0,
						cacheWrite: 1,
						totalTokens: 8,
						cost: { input: 0.03, output: 0.04, cacheRead: 0, cacheWrite: 0.01, total: 0.08 },
					},
				},
			},
		]);
		await writeFile(
			join(sourceBDir, "broken.jsonl"),
			[
				JSON.stringify({
					type: "session",
					id: "broken",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: "/workspace/broken",
				}),
				"{not-json}",
			].join("\n"),
			"utf-8",
		);

		const stats = await analyzeCommunityTraces(root);
		assert.equal(stats.totalFiles, 5);
		assert.equal(stats.totalSessions, 3);
		assert.equal(stats.parsedSessions, 2);
		assert.equal(stats.failedSessions, 1);
		assert.equal(stats.sources["alice/repo-a"].parsedSessions, 1);
		assert.equal(stats.sources["bob/repo-b"].parsedSessions, 1);
		assert.equal(stats.sources["bob/repo-b"].failedSessions, 1);
		assert.equal(stats.sources["cfahlgren1/agent-sessions-list/sessions/claude"], undefined);
		assert.equal(stats.topToolNames.bash, 1);
		assert.equal(stats.providers.anthropic, 2);
		assert.equal(stats.providers.openai, 2);
		assert.ok(stats.failureTags.weak_validation >= 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
