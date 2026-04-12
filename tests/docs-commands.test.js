import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAINTAINER_COMMAND_FILES = [
	"docs/internal/reproducibility.md",
	"docs/internal/baseline-results.md",
	"docs/internal/handoff-2026-04-10-terminal-bench.md",
	"benchmarks/harbor/README.md",
	"benchmarks/slopcodebench/README.md",
	"benchmarks/harbor/preflight.ts",
	"blueprints/changes/meta-harness-optimization/tasks.md",
];

test("maintainer docs only reference npm scripts that exist in package.json", async () => {
	const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf-8"));
	const scripts = new Set(Object.keys(pkg.scripts ?? {}));

	for (const relativePath of MAINTAINER_COMMAND_FILES) {
		const file = join(REPO_ROOT, relativePath);
		const contents = await readFile(file, "utf-8");
		const commands = [...contents.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)].map((match) => match[1]);
		for (const command of commands) {
			assert.equal(scripts.has(command), true, `${relativePath} references missing npm script: ${command}`);
		}
	}
});
