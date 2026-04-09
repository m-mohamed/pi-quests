import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTIVE_FILES = [
	"package.json",
	"README.md",
	"docs/benchmark-card.md",
	"docs/methodology.md",
	"docs/reproducibility.md",
	"docs/baseline-results.md",
	"docs/arxiv-paper.md",
	"docs/tutorial.md",
	"docs/harness-engineering-deep-dive.md",
	"benchmarks/harbor/README.md",
	"benchmarks/slopcodebench/README.md",
];
const BANNED_REFERENCES = [
	"runQuestTrialsLoop",
	"executeTrialCandidateAgent",
	"trace-replays",
	"terminal-bench-replays",
	"slopcodebench-replays",
	".pi/quests/lab",
	".pi/quests/meta-harness",
	"benchmark:slop:smoke",
	"benchmark:slop:local",
];

async function collectTrackedTextFiles(root) {
	const collected = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const next = join(root, entry.name);
		if (entry.isDirectory()) {
			collected.push(...(await collectTrackedTextFiles(next)));
			continue;
		}
		if (entry.isFile() && /\.(ts|js|json|md)$/.test(entry.name)) collected.push(next);
	}
	return collected;
}

test("shipped source and active docs are free of replay-era trials references", async () => {
	const files = [
		...(await collectTrackedTextFiles(join(REPO_ROOT, "src"))),
		...(await collectTrackedTextFiles(join(REPO_ROOT, "benchmarks"))),
		...ACTIVE_FILES.map((file) => join(REPO_ROOT, file)).filter((file) => existsSync(file)),
	];
	for (const file of files) {
		const contents = await readFile(file, "utf-8");
		for (const banned of BANNED_REFERENCES) {
			assert.equal(
				contents.includes(banned),
				false,
				`${file} still references banned legacy text: ${banned}`,
			);
		}
	}
});
