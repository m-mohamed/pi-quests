import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBenchmarkModel, missingEnvVarsForModel } from "../shared.js";

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function parseModel(argv: string[]): string {
	const index = argv.indexOf("--model");
	return index >= 0 && argv[index + 1] ? argv[index + 1] : defaultBenchmarkModel();
}

async function runCheck(name: string, command: string, args: string[] = []): Promise<CheckResult> {
	const proc = spawn(command, args, {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	proc.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	proc.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	return await new Promise<CheckResult>((resolvePromise) => {
		proc.on("close", (code) => {
			resolvePromise({
				name,
				ok: (code ?? 1) === 0,
				detail: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `exit=${code ?? 1}`,
			});
		});
		proc.on("error", (error) => {
			resolvePromise({
				name,
				ok: false,
				detail: String(error),
			});
		});
	});
}

async function main() {
	const model = parseModel(process.argv.slice(2));
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const checks: CheckResult[] = [
		await runCheck("harbor", "harbor", ["--version"]),
		await runCheck("docker", "docker", ["ps"]),
		await runCheck("quest-headless", process.execPath, [resolve(rootDir, "bin", "quest-headless.mjs"), "--help"]),
	];
	const missing = missingEnvVarsForModel(model);
	checks.push({
		name: "model-credentials",
		ok: missing.length === 0,
		detail: missing.length === 0 ? `Credentials available for ${model}` : `Missing one of: ${missing.join(", ")}`,
	});
	const failed = checks.filter((check) => !check.ok);
	console.log(JSON.stringify({ model, checks, ok: failed.length === 0 }, null, 2));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
