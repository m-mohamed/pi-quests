import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuest, loadActiveQuest, projectIdFor } from "../src/state-core.ts";
import { createLiveRunSnapshot } from "../src/telemetry-core.ts";

const DEFAULT_MODEL = {
	provider: "zai",
	model: "glm-5.1",
	thinkingLevel: "high",
};

test("core keeps quest state repo-local", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-core-"));
	try {
		const quest = await createQuest(cwd, "Ship the quest shell", DEFAULT_MODEL);
		const activeQuest = await loadActiveQuest(cwd);
		const snapshot = createLiveRunSnapshot("worker", { featureId: "f1", milestoneId: "m1" });

		assert.equal(quest.projectId, projectIdFor(cwd));
		assert.equal(activeQuest?.id, quest.id);
		assert.equal(activeQuest?.cwd, cwd);
		assert.equal(snapshot.role, "worker");
		assert.equal(snapshot.phase, "starting");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
