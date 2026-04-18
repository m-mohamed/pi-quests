import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const REPO = "/Users/mohamedmohamed/research/pi-quests";

function trackedFiles() {
	return execFileSync("git", ["-C", REPO, "ls-files"], { encoding: "utf-8" })
		.split("\n")
		.filter(Boolean);
}

function rgNoMatches(pattern, paths) {
	try {
		const output = execFileSync("rg", ["-n", pattern, ...paths], { encoding: "utf-8" });
		return output.trim();
	} catch (error) {
		if (error && typeof error === "object" && "status" in error && error.status === 1) return "";
		throw error;
	}
}

test("maintainer docs only reference live internal eval scripts", () => {
	const packageJson = JSON.parse(readFileSync(`${REPO}/package.json`, "utf-8"));
	const docFiles = [
		`${REPO}/README.md`,
		`${REPO}/docs/tutorial.md`,
		`${REPO}/docs/internal/README.md`,
		`${REPO}/docs/internal/reproducibility.md`,
		`${REPO}/docs/internal/baseline-results.md`,
		`${REPO}/evals/frontierswe/README.md`,
	];
	const scriptMatches = execFileSync("rg", ["-o", "npm run [A-Za-z0-9:.-]+", ...docFiles], { encoding: "utf-8" })
		.split("\n")
		.filter(Boolean)
		.map((line) => line.replace(/^.*npm run /, "").trim());

	for (const script of scriptMatches) {
		assert.ok(packageJson.scripts?.[script], `missing package script for ${script}`);
	}
});

test("tracked docs and help surfaces do not mention removed benchmark commands", () => {
	const files = trackedFiles().filter((file) =>
		(file === "package.json" ||
			file === "README.md" ||
			file.startsWith("docs/") ||
			file.startsWith("evals/")) &&
		existsSync(`${REPO}/${file}`),
	);
	const output = rgNoMatches(
		"terminal-bench|slopcodebench|internal:benchmark|prepare-benchmark|--benchmark|benchmarks/harbor|benchmarks/slopcodebench",
		files.map((file) => `${REPO}/${file}`),
	);
	assert.equal(output.trim(), "");
});
