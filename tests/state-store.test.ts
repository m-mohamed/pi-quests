import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	appendQuestEvent,
	createQuest,
	getQuestPathsFromAgentDir,
	loadActiveQuest,
	loadLearnedWorkflows,
	loadQuest,
	pruneQuestStorage,
	saveLearnedWorkflows,
	saveQuest,
	writeWorkerRun,
} from "../src/state-core.js";

describe("quest state store", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-quests-agent-"));
		cwd = join(agentDir, "repo");
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	test("round-trips quest state and project workflows", async () => {
		const quest = await createQuest(agentDir, cwd, "Ship a validation-first quest flow", {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		});

		quest.lastSummary = "Proposal captured.";
		await saveQuest(agentDir, quest);
		await appendQuestEvent(agentDir, cwd, quest.id, { ts: Date.now(), type: "quest_saved" });
		await saveLearnedWorkflows(agentDir, cwd, [
			{
				id: "wf-1",
				title: "Start Docker before quest checks",
				note: "Docker needs to be running before validation.",
				source: "validator_failure",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				evidence: ["docker not running"],
			},
		]);

		const loadedQuest = await loadQuest(agentDir, cwd, quest.id);
		const activeQuest = await loadActiveQuest(agentDir, cwd);
		const workflows = await loadLearnedWorkflows(agentDir, cwd);

		expect(loadedQuest?.goal).toBe("Ship a validation-first quest flow");
		expect(loadedQuest?.lastSummary).toBe("Proposal captured.");
		expect(activeQuest?.id).toBe(quest.id);
		expect(workflows).toHaveLength(1);
		expect(workflows[0]?.title).toBe("Start Docker before quest checks");
	});

	test("loads legacy mission storage from the old missions root", async () => {
		const quest = await createQuest(agentDir, cwd, "Migrate legacy mission storage", {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		});

		const projectId = quest.projectId;
		const legacyProjectDir = join(agentDir, "missions", projectId);
		const legacyQuestDir = join(legacyProjectDir, quest.id);
		await mkdir(legacyQuestDir, { recursive: true });
		await writeFile(join(legacyProjectDir, "active.json"), `${JSON.stringify({ missionId: quest.id })}\n`, "utf-8");
		await writeFile(join(legacyQuestDir, "mission.json"), `${JSON.stringify(quest, null, 2)}\n`, "utf-8");
		await rm(join(agentDir, "quests"), { recursive: true, force: true });

		const loadedQuest = await loadQuest(agentDir, cwd, quest.id);
		const activeQuest = await loadActiveQuest(agentDir, cwd);

		expect(loadedQuest?.goal).toBe("Migrate legacy mission storage");
		expect(activeQuest?.id).toBe(quest.id);
	});

	test("prunes terminal quest runtime files but keeps quest metadata", async () => {
		const quest = await createQuest(agentDir, cwd, "Prune old runtime logs", {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		});
		quest.status = "completed";
		quest.plan = {
			title: "Prune runtime logs",
			summary: "Retain quest metadata while pruning runtime artifacts",
			successCriteria: ["Quest metadata survives pruning"],
			milestones: [
				{
					id: "m1",
					title: "Validate prune",
					summary: "Confirm prune boundaries",
					successCriteria: ["Only runtime logs are removed"],
					status: "completed",
				},
			],
			features: [
				{
					id: "f1",
					title: "Keep quest metadata",
					summary: "Retain the quest plan and validation contract",
					milestoneId: "m1",
					acceptanceCriteria: ["quest.json still contains the validation contract"],
					status: "completed",
				},
			],
			validationContract: {
				summary: "Prune keeps the durable quest contract.",
				milestoneExpectations: [
					{
						milestoneId: "m1",
						title: "Validate prune",
						expectedBehaviors: ["quest.json still has the validation contract"],
					},
				],
				featureChecks: [
					{
						featureId: "f1",
						title: "Keep quest metadata",
						criterionIds: ["criterion-1"],
					},
				],
				criteria: [
					{
						id: "criterion-1",
						title: "Quest metadata is retained",
						milestoneId: "m1",
						featureIds: ["f1"],
						expectedBehavior: "quest.json still contains the validation contract",
						proofStrategy: "read_only",
						proofDetails: "Reload the quest after prune and confirm the validation contract remains.",
						commands: [],
						confidence: "high",
					},
				],
				weakValidationWarnings: [],
			},
		};
		await saveQuest(agentDir, quest);
		await saveLearnedWorkflows(agentDir, cwd, [
			{
				id: "wf-1",
				title: "Keep learned workflows private",
				note: "Learned workflows should survive prune because only runtime logs are removed.",
				source: "validator_success",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				evidence: ["prune keeps metadata"],
			},
		]);
		const paths = getQuestPathsFromAgentDir(agentDir, cwd, quest.id);
		const persistedQuest = JSON.parse(await readFile(paths.questFile, "utf-8"));
		persistedQuest.updatedAt = Date.now() - 1000 * 60 * 60 * 24 * 30;
		await writeFile(paths.questFile, `${JSON.stringify(persistedQuest, null, 2)}\n`, "utf-8");

		await writeWorkerRun(agentDir, cwd, quest.id, {
			id: "run-1",
			role: "validator",
			milestoneId: "m1",
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
			exitCode: 0,
			ok: true,
			summary: "Validated milestone",
			phase: "completed",
			events: [],
		});
		await writeFile(paths.eventsFile, '{"type":"synthetic"}\n', "utf-8");

		const result = await pruneQuestStorage(agentDir);
		const reloaded = await loadQuest(agentDir, cwd, quest.id);
		const workflows = await loadLearnedWorkflows(agentDir, cwd);
		const questFile = join(agentDir, "quests", reloaded!.projectId, quest.id, "quest.json");
		const persisted = JSON.parse(await readFile(questFile, "utf-8"));

		expect(result.deletedRuns).toBe(1);
		expect(await Bun.file(paths.eventsFile).exists()).toBe(false);
		expect(reloaded?.plan?.validationContract.criteria[0]?.title).toBe("Quest metadata is retained");
		expect(workflows).toHaveLength(1);
		expect(workflows[0]?.title).toBe("Keep learned workflows private");
		expect(typeof reloaded?.prunedAt).toBe("number");
		expect(typeof persisted.prunedAt).toBe("number");
	});
});
