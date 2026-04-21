import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import questExtension from "../src/index.ts";

test("public package only exposes quest surfaces", () => {
	const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
	const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

	assert.equal(typeof questExtension, "function");
	assert.deepEqual(Object.keys(packageJson.bin), ["quest-headless"]);
	assert.equal(packageJson.exports["."], "./src/index.ts");
	assert.equal(packageJson.exports["./quest-headless"], "./src/quest-headless.ts");
	assert.ok(packageJson.files.every((entry) => entry !== "evals" && entry !== "docs/internal"));
});
