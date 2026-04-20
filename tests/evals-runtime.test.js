import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const REPO = "/Users/mohamedmohamed/research/pi-quests";

function rgNoMatches(pattern, paths) {
	try {
		const output = execFileSync("rg", ["-n", pattern, ...paths], { encoding: "utf-8" });
		return output.trim();
	} catch (error) {
		if (error && typeof error === "object" && "status" in error && error.status === 1) return "";
		throw error;
	}
}

test("source tree stays on the current eval-native internal surface", () => {
	const matches = rgNoMatches("quest-evals-controller|frontier-optimizer|frontierswe-evals|docker-eval-runtime", [`${REPO}/src`]);
	assert.notEqual(matches, "");
});
