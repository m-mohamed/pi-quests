import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeQuestBundle } from "./run.js";
import { credentialsAvailableForModel, defaultBenchmarkModel } from "../shared.js";

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function parseProviderAndModel(model: string): { provider: string; modelName: string } {
	const splitAt = model.indexOf("/");
	return splitAt > 0
		? { provider: model.slice(0, splitAt), modelName: model.slice(splitAt + 1) }
		: { provider: model, modelName: model };
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

async function bundleChecks(rootDir: string, model: string): Promise<CheckResult[]> {
	const bundle = await materializeQuestBundle(rootDir);
	try {
		const bundledPi = resolve(bundle.bundlePath, "node_modules", ".bin", "pi");
		const bundledHeadless = resolve(bundle.bundlePath, "dist", "quest-headless.js");
		const { provider, modelName } = parseProviderAndModel(model);
		const checks: CheckResult[] = [
			{
				name: "bundle-pi-bin",
				ok: existsSync(bundledPi),
				detail: existsSync(bundledPi) ? `${bundledPi} (${bundle.piVersion})` : `Missing bundled Pi binary at ${bundledPi}`,
			},
			await runCheck("bundle-quest-headless", process.execPath, [bundledHeadless, "--help"]),
			await runCheck("bundle-pi-version", bundledPi, ["--version"]),
		];
		const modelSupport = await runCheck("bundle-model-support", bundledPi, ["--list-models", provider]);
		checks.push({
			...modelSupport,
			ok: modelSupport.ok && modelSupport.detail.includes(modelName),
			detail: modelSupport.ok
				? modelSupport.detail.includes(modelName)
					? `Bundled Pi ${bundle.piVersion} exposes ${model}`
					: `Bundled Pi ${bundle.piVersion} does not list ${model}`
				: modelSupport.detail,
		});
		return checks;
	} finally {
		await bundle.cleanup();
	}
}

async function main() {
	const model = parseModel(process.argv.slice(2));
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const credentialStatus = credentialsAvailableForModel(model);
	const checks: CheckResult[] = [
		await runCheck("harbor", "harbor", ["--version"]),
		await runCheck("docker", "docker", ["ps"]),
		await runCheck("quest-headless-cli", process.execPath, [resolve(rootDir, "bin", "quest-headless.mjs"), "--help"]),
	];
	checks.push({
		name: "model-credentials",
		...credentialStatus,
	});
	checks.push(...(await bundleChecks(rootDir, model)));
	const authPath = resolve(homedir(), ".pi", "agent", "auth.json");
	checks.push({
		name: "pi-auth-file",
		ok: existsSync(authPath) || credentialStatus.ok,
		detail: existsSync(authPath)
			? authPath
			: credentialStatus.ok
				? `Pi auth file not found at ${authPath}, but benchmark credentials are otherwise available`
				: `Pi auth file not found at ${authPath}`,
	});
	const failed = checks.filter((check) => !check.ok);
	console.log(JSON.stringify({ model, checks, ok: failed.length === 0 }, null, 2));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
