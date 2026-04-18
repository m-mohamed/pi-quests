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

test("source tree no longer imports removed Harbor modules", () => {
	const matches = rgNoMatches("harbor-integrity|harbor-runtime|benchmark-helpers", [`${REPO}/src`]);
	assert.equal(matches, "");
});

test("source tree no longer carries removed benchmark family names", () => {
	const matches = rgNoMatches(
		"terminal-bench|slopcodebench|search-benchmark|hold-out-benchmark",
		[`${REPO}/src`],
	);
	assert.equal(matches, "");
});
