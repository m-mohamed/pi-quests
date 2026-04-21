#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliFile = join(rootDir, "src", "quest-eval-headless.ts");
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const child = spawn(process.execPath, ["--import", tsxLoader, cliFile, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});

child.on("close", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
