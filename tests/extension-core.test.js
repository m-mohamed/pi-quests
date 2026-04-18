import test from "node:test";
import assert from "node:assert/strict";
import {
	buildQuestShellEnvironment,
	discoverQuestSkillPaths,
	formatContextUsageLabel,
	prefixQuestShellCommand,
	protectedQuestArtifactReason,
	questToolResultGuidance,
} from "../src/extension-core.js";

test("discoverQuestSkillPaths exposes shared and active quest skill directories", () => {
	const paths = discoverQuestSkillPaths("/tmp/pi-quests", "quest-123");
	assert.deepEqual(paths, [
		"/tmp/pi-quests/.pi/quests/quest-123/skills",
		"/tmp/pi-quests/.pi/quests/shared-skills",
	]);
});

test("discoverQuestSkillPaths always exposes shared quest skills", () => {
	const paths = discoverQuestSkillPaths("/tmp/pi-quests");
	assert.deepEqual(paths, ["/tmp/pi-quests/.pi/quests/shared-skills"]);
});

test("protectedQuestArtifactReason blocks raw writes to quest control artifacts and skills", () => {
	assert.match(
		protectedQuestArtifactReason("/tmp/pi-quests", "/tmp/pi-quests/.pi/quests/quest-123/proposal.md") ?? "",
		/quest control files/i,
	);
	assert.match(
		protectedQuestArtifactReason("/tmp/pi-quests", "/tmp/pi-quests/.pi/quests/quest-123/skills/checklist.md") ?? "",
		/quest skills/i,
	);
	assert.match(
		protectedQuestArtifactReason("/tmp/pi-quests", "/tmp/pi-quests/.pi/quests/shared-skills/review.md") ?? "",
		/quest skills/i,
	);
	assert.equal(protectedQuestArtifactReason("/tmp/pi-quests", "/tmp/pi-quests/src/index.ts"), null);
});

test("formatContextUsageLabel renders a compact Pi-native context meter", () => {
	assert.equal(formatContextUsageLabel(null), null);
	assert.equal(formatContextUsageLabel({ tokens: null, percent: null, contextWindow: 200000 }), null);
	assert.equal(formatContextUsageLabel({ tokens: 18450, percent: 9.225, contextWindow: 200000 }), "ctx 9% · 18.4k/200k");
});

test("buildQuestShellEnvironment exports active quest and trial metadata for agent bash calls", () => {
	const env = buildQuestShellEnvironment(
		"/tmp/pi-quests",
		{ id: "quest-123", cwd: "/tmp/pi-quests", status: "running" },
		{
			status: "running",
			activeProfileId: "repo-project-ui",
			evalFamily: "frontierswe",
			evalDataset: "frontierswe-sample@v1",
		},
	);
	assert.equal(env.PI_QUESTS_ACTIVE_QUEST_ID, "quest-123");
	assert.equal(env.PI_QUESTS_ACTIVE_QUEST_STATUS, "running");
	assert.equal(env.PI_QUESTS_ACTIVE_QUEST_ROOT, "/tmp/pi-quests/.pi/quests/quest-123");
	assert.equal(env.PI_QUESTS_TRIAL_PROFILE_ID, "repo-project-ui");
	assert.equal(env.PI_QUESTS_TRIAL_EVAL, "frontierswe");
	assert.equal(env.PI_QUESTS_TRIAL_SUITE, "frontierswe-sample@v1");
});

test("prefixQuestShellCommand prepends shell-safe exports without changing empty env commands", () => {
	assert.equal(prefixQuestShellCommand("npm test", {}), "npm test");
	const prefixed = prefixQuestShellCommand("npm test", {
		PI_QUESTS_ACTIVE_QUEST_ID: "quest-123",
		PI_QUESTS_NOTE: "it's live",
	});
	assert.match(prefixed, /export PI_QUESTS_ACTIVE_QUEST_ID='quest-123'/);
	assert.match(prefixed, /export PI_QUESTS_NOTE='it'"'"'s live'/);
	assert.match(prefixed, /\nnpm test$/);
});

test("questToolResultGuidance adds focused follow-up hints for spilled bash and truncated reads", () => {
	assert.match(
		questToolResultGuidance({
			toolName: "bash",
			details: { fullOutputPath: "/tmp/pi-quests/.pi/quests/quest-123/reports/build.log" },
		}) ?? "",
		/full command output was spilled/i,
	);
	assert.match(
		questToolResultGuidance({
			toolName: "read",
			details: { truncation: { reason: "line_limit" } },
			input: { path: "/tmp/pi-quests/src/index.ts" },
		}) ?? "",
		/re-read .*offset\/limit/i,
	);
	assert.match(
		questToolResultGuidance({
			toolName: "grep",
			details: { matchLimitReached: 200 },
			input: { pattern: "Quest", path: "/tmp/pi-quests/src" },
		}) ?? "",
		/search results were truncated/i,
	);
	assert.match(
		questToolResultGuidance({
			toolName: "find",
			details: { resultLimitReached: 100 },
			input: { pattern: "*.ts", path: "/tmp/pi-quests/src" },
		}) ?? "",
		/file search hit a result limit/i,
	);
	assert.match(
		questToolResultGuidance({
			toolName: "ls",
			details: { entryLimitReached: 50 },
			input: { path: "/tmp/pi-quests/src" },
		}) ?? "",
		/directory listing was truncated/i,
	);
	assert.equal(questToolResultGuidance({ toolName: "grep", details: undefined }), null);
});
