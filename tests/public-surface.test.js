import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("public docs stay Quest-first and do not expose maintainer-only eval optimizer details", async () => {
	const readme = await readFile(join(REPO_ROOT, "README.md"), "utf-8");
	const tutorial = await readFile(join(REPO_ROOT, "docs", "tutorial.md"), "utf-8");
	const architecture = await readFile(join(REPO_ROOT, "docs", "quest-architecture.md"), "utf-8");
	const publicText = `${readme}\n${tutorial}\n${architecture}`;

	for (const banned of [
		"ctrl+alt+t",
		"internal optimizer environment variables",
		"/quest evals",
		"frontier optimizer",
	]) {
		assert.equal(publicText.includes(banned), false, `public docs still mention internal surface: ${banned}`);
	}
});

test("published package files exclude maintainer-only internals", async () => {
	const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf-8"));
	const files = new Set(pkg.files ?? []);

	for (const forbidden of [
		"docs/internal/README.md",
		"src/internal-headless.ts",
		"src/internal-ui.ts",
		"src/internal-profile-core.ts",
		"benchmarks",
	]) {
		assert.equal(files.has(forbidden), false, `published package still includes internal entry: ${forbidden}`);
	}
});
