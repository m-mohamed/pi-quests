import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import questEvalsExtension from "../src/index.ts";
import { getQuestOptimizerPaths, loadQuestOptimizerState } from "../src/state-core.ts";

test("eval package owns optimizer state under .pi/quests/evals", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-quests-evals-"));
	try {
		const state = await loadQuestOptimizerState(cwd, { ensure: true });
		const paths = getQuestOptimizerPaths(cwd);

		assert.equal(typeof questEvalsExtension, "function");
		assert.equal(state.evalFamily, "frontierswe");
		assert.equal(state.evalDataset, "frontierswe-sample@v1");
		assert.equal(paths.rootDir, join(cwd, ".pi", "quests", "evals"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
