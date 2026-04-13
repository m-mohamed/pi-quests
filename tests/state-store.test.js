import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuest, getQuestPaths, loadActiveQuest, loadLearnedWorkflows, loadQuest, saveLearnedWorkflows, saveQuest } from "../src/state-core.js";

test("quest state sync writes canonical repo-local artifacts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-repo-"));
	try {
		const quest = await createQuest(cwd, "Ship quest control", {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		});

		quest.status = "proposal_ready";
		quest.plan = {
			title: "Quest Control",
			summary: "Build the quest package",
			risks: ["User-surface validation is limited in CI."],
			environment: ["Use repo-local .pi/quests storage."],
			services: [{ name: "web", purpose: "dev server", commands: ["npm run dev"], ports: [3000] }],
			humanQaChecklist: ["Run through Quest Control manually."],
			milestones: [{ id: "m1", order: 1, title: "MVP", description: "Ship the first cut", successCriteria: [], status: "pending" }],
			features: [
				{
					id: "f1",
					order: 1,
					milestoneId: "m1",
					title: "Quest dashboard",
					description: "Render the dashboard",
					preconditions: [],
					fulfills: ["a1"],
					status: "pending",
				},
			],
		};
		quest.validationReadiness = {
			summary: "Repo checks supported; browser validation limited.",
			checks: [
				{ id: "checks", surface: "repo-checks", description: "npm test", status: "supported", commands: ["npm test"], evidence: [] },
				{ id: "browser", surface: "browser", description: "Quest Control UI", status: "limited", commands: [], evidence: ["No browser harness in test env"] },
			],
		};
		quest.validationState = {
			assertions: [{ id: "a1", milestoneId: "m1", description: "Dashboard renders", method: "user_surface", criticality: "critical", status: "pending", evidence: [] }],
			updatedAt: Date.now(),
		};
		await saveQuest(quest);

		await saveLearnedWorkflows(cwd, [
			{
				id: "wf-1",
				title: "Start local services before validation",
				note: "Quest validation depends on the local stack being up.",
				source: "validator_success",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				evidence: ["readiness probe detected npm run dev"],
			},
		]);

		const paths = getQuestPaths(cwd, quest.id);
		assert.equal(existsSync(paths.questFile), true);
		assert.equal(existsSync(paths.proposalFile), true);
		assert.equal(existsSync(paths.validationReadinessFile), true);
		assert.equal(existsSync(paths.validationContractFile), true);
		assert.equal(existsSync(paths.validationStateFile), true);
		assert.equal(existsSync(paths.featuresFile), true);
		assert.equal(existsSync(paths.servicesFile), true);

		const servicesYaml = await readFile(paths.servicesFile, "utf-8");
		assert.match(servicesYaml, /name: web/);
		const stagedTemps = (await readdir(paths.questDir)).filter((entry) => entry.includes(".tmp-"));
		assert.deepEqual(stagedTemps, []);

		const loaded = await loadQuest(cwd, quest.id);
		const active = await loadActiveQuest(cwd);
		const workflows = await loadLearnedWorkflows(cwd);
		assert.equal(loaded?.status, "proposal_ready");
		assert.equal(active?.id, quest.id);
		assert.equal(workflows.length, 1);
		assert.equal(existsSync(join(paths.sharedSkillsDir, "start-local-services-before-validation-wf-1.md")), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
