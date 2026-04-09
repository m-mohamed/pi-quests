import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHarborCommand, materializeQuestBundle } from "./run.js";
import { credentialsAvailableForModel, defaultBenchmarkModel } from "../shared.js";

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

interface PreflightOptions {
	model: string;
	skipSmoke: boolean;
	smokeTask: string;
	jobsDir?: string;
}

export const PREFLIGHT_SMOKE_DATASET = "terminal-bench-sample@2.0";
export const DEFAULT_PREFLIGHT_SMOKE_TASK = "regex-log";

function parseProviderAndModel(model: string): { provider: string; modelName: string } {
	const splitAt = model.indexOf("/");
	return splitAt > 0
		? { provider: model.slice(0, splitAt), modelName: model.slice(splitAt + 1) }
		: { provider: model, modelName: model };
}

function parseArgs(argv: string[]): PreflightOptions {
	const index = argv.indexOf("--model");
	const smokeTaskIndex = argv.indexOf("--smoke-task");
	const jobsDirIndex = argv.indexOf("--jobs-dir");
	return {
		model: index >= 0 && argv[index + 1] ? argv[index + 1] : defaultBenchmarkModel(),
		skipSmoke: argv.includes("--skip-smoke"),
		smokeTask: smokeTaskIndex >= 0 && argv[smokeTaskIndex + 1] ? argv[smokeTaskIndex + 1] : DEFAULT_PREFLIGHT_SMOKE_TASK,
		jobsDir: jobsDirIndex >= 0 && argv[jobsDirIndex + 1] ? resolve(argv[jobsDirIndex + 1]) : undefined,
	};
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

async function bundleChecks(
	bundle: { bundlePath: string; nodeRuntimePath: string; piVersion: string },
	model: string,
): Promise<CheckResult[]> {
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
}

function trimDetail(text: string, maxChars = 4000): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `...${normalized.slice(normalized.length - maxChars)}`;
}

async function collectFiles(root: string, expectedName: string): Promise<string[]> {
	const matches: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const next = join(root, entry.name);
		if (entry.isDirectory()) {
			matches.push(...(await collectFiles(next, expectedName)));
			continue;
		}
		if (entry.isFile() && entry.name === expectedName) matches.push(next);
	}
	return matches;
}

async function latestHarborJobDir(jobsDir: string): Promise<string | null> {
	if (!existsSync(jobsDir)) return null;
	const entries = await readdir(jobsDir, { withFileTypes: true });
	const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
	return candidates[0] ? join(jobsDir, candidates[0]) : null;
}

function normalizeHarborTaskFilter(taskName: string): string {
	const trimmed = taskName.trim();
	if (!trimmed) return DEFAULT_PREFLIGHT_SMOKE_TASK;
	return basename(trimmed);
}

export async function inspectHarborSmokeJobs(jobsDir: string, smokeTask: string): Promise<CheckResult> {
	const jobDir = await latestHarborJobDir(jobsDir);
	if (!jobDir) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: `No Harbor smoke job directory was created under ${jobsDir}`,
		};
	}
	const resultPath = join(jobDir, "result.json");
	if (!existsSync(resultPath)) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: `Harbor smoke job is missing ${resultPath}`,
		};
	}
	const result = JSON.parse(await readFile(resultPath, "utf-8")) as {
		n_total_trials?: number;
		stats?: { n_errors?: number };
	};
	if ((result.n_total_trials ?? 0) !== 1) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: `Expected exactly one Harbor smoke trial for ${smokeTask}, found ${result.n_total_trials ?? 0} in ${resultPath}`,
		};
	}
	if ((result.stats?.n_errors ?? 0) > 0) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: `Harbor smoke task ${smokeTask} recorded ${result.stats?.n_errors ?? 0} error(s). Inspect ${jobDir}`,
		};
	}
	const questOutputs = await collectFiles(jobDir, "quest-headless-output.json");
	if (questOutputs.length === 0) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: `Harbor smoke task ${smokeTask} completed without a quest-headless-output.json artifact in ${jobDir}`,
		};
	}
	for (const outputPath of questOutputs.sort()) {
		const raw = (await readFile(outputPath, "utf-8")).trim();
		if (!raw) continue;
		const payload = JSON.parse(raw) as {
			status?: string;
			data?: { status?: string; benchmark?: { passed?: boolean; taskId?: string } };
		};
		if (payload.status === "ok" && payload.data?.status === "completed") {
			return {
				name: "harbor-smoke",
				ok: true,
				detail: `Harbor smoke task ${smokeTask} completed and produced Quest JSON in ${basename(jobDir)}.`,
			};
		}
	}
	return {
		name: "harbor-smoke",
		ok: false,
		detail: `Harbor smoke task ${smokeTask} ran, but no quest-headless-output.json artifact reported a completed Quest run in ${jobDir}`,
	};
}

async function runHarborSmoke(
	rootDir: string,
	model: string,
	smokeTask: string,
	jobsDir: string,
	bundle: { bundlePath: string; nodeRuntimePath: string; piVersion: string },
): Promise<CheckResult> {
	const normalizedTask = normalizeHarborTaskFilter(smokeTask);
	const command = buildHarborCommand({
		dataset: PREFLIGHT_SMOKE_DATASET,
		runMode: "smoke",
		model,
		bundlePath: bundle.bundlePath,
		nodeRuntimePath: bundle.nodeRuntimePath,
		authDir: bundle.authDir,
		jobsDir,
		maxTasks: 1,
		nConcurrent: 1,
		includeTaskNames: [normalizedTask],
	});
	const proc = spawn(command.command, command.args, {
		env: {
			...process.env,
			...command.env,
		},
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
	const exitCode = await new Promise<number>((resolvePromise, reject) => {
		proc.on("close", (code) => resolvePromise(code ?? 1));
		proc.on("error", reject);
	});
	if (exitCode !== 0) {
		return {
			name: "harbor-smoke",
			ok: false,
			detail: trimDetail(
				[
					`Harbor smoke task ${normalizedTask} failed with exit=${exitCode}.`,
					`Jobs dir: ${jobsDir}`,
					stdout.trim(),
					stderr.trim(),
				]
					.filter(Boolean)
					.join("\n"),
			),
		};
	}
	return inspectHarborSmokeJobs(jobsDir, normalizedTask);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { model } = options;
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
	const bundle = await materializeQuestBundle(rootDir);
	try {
		checks.push(...(await bundleChecks(bundle, model)));
		if (checks.every((check) => check.ok)) {
			if (options.skipSmoke) {
				checks.push({
					name: "harbor-smoke",
					ok: true,
					detail: `Skipped Harbor smoke probe for ${options.smokeTask} via --skip-smoke`,
				});
			} else {
				const jobsDir = options.jobsDir ?? resolve(rootDir, "benchmarks", ".runs", "harbor", "preflight-smoke");
				checks.push(await runHarborSmoke(rootDir, model, options.smokeTask, jobsDir, bundle));
			}
		}
	} finally {
		await bundle.cleanup();
	}
	const failed = checks.filter((check) => !check.ok);
	console.log(JSON.stringify({ model, checks, ok: failed.length === 0 }, null, 2));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
