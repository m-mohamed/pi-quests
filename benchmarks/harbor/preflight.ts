import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHarborInstallation } from "../../src/harbor-integrity.js";
import { buildHarborCommand, materializeQuestBundle } from "./run.js";
import { credentialsAvailableForModel, defaultBenchmarkModel } from "../shared.js";

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
	jobDir?: string;
	artifactPath?: string;
	context?: Record<string, unknown>;
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

function tailLines(text: string, maxLines = 40, maxChars = 2500): string {
	const normalized = text.trim();
	if (!normalized) return "";
	const tail = normalized.split("\n").slice(-maxLines).join("\n");
	return trimDetail(tail, maxChars);
}

async function readLogTail(filePath: string): Promise<string> {
	if (!existsSync(filePath)) return "";
	return tailLines(await readFile(filePath, "utf-8"));
}

async function mostRelevantSmokeArtifact(jobDir: string): Promise<{ artifactPath: string; tail: string } | null> {
	for (const candidate of [join(jobDir, "exception.txt"), join(jobDir, "job.log")]) {
		const tail = await readLogTail(candidate);
		if (tail) return { artifactPath: candidate, tail };
	}
	for (const expectedName of ["quest-headless-stderr.log", "trial.log"]) {
		const matches = (await collectFiles(jobDir, expectedName)).sort();
		for (const filePath of matches) {
			const tail = await readLogTail(filePath);
			if (tail) return { artifactPath: filePath, tail };
		}
	}
	return null;
}

async function withSmokeDebugDetail(
	jobDir: string,
	message: string,
): Promise<{ detail: string; artifactPath?: string }> {
	const debugArtifact = await mostRelevantSmokeArtifact(jobDir);
	if (!debugArtifact) {
		return {
			detail: `${message}\nJob dir: ${jobDir}`,
		};
	}
	return {
		detail: `${message}\nJob dir: ${jobDir}\nArtifact tail (${debugArtifact.artifactPath}):\n${debugArtifact.tail}`,
		artifactPath: debugArtifact.artifactPath,
	};
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
		const debug = await withSmokeDebugDetail(jobDir, `Harbor smoke job is missing ${resultPath}`);
		return {
			name: "harbor-smoke",
			ok: false,
			detail: debug.detail,
			jobDir,
			artifactPath: debug.artifactPath,
		};
	}
	const result = JSON.parse(await readFile(resultPath, "utf-8")) as {
		n_total_trials?: number;
		stats?: { n_errors?: number };
	};
	if ((result.n_total_trials ?? 0) !== 1) {
		const debug = await withSmokeDebugDetail(
			jobDir,
			`Expected exactly one Harbor smoke trial for ${smokeTask}, found ${result.n_total_trials ?? 0} in ${resultPath}`,
		);
		return {
			name: "harbor-smoke",
			ok: false,
			detail: debug.detail,
			jobDir,
			artifactPath: debug.artifactPath,
		};
	}
	if ((result.stats?.n_errors ?? 0) > 0) {
		const debug = await withSmokeDebugDetail(
			jobDir,
			`Harbor smoke task ${smokeTask} recorded ${result.stats?.n_errors ?? 0} error(s).`,
		);
		return {
			name: "harbor-smoke",
			ok: false,
			detail: debug.detail,
			jobDir,
			artifactPath: debug.artifactPath,
		};
	}
	const questOutputs = await collectFiles(jobDir, "quest-headless-output.json");
	if (questOutputs.length === 0) {
		const debug = await withSmokeDebugDetail(
			jobDir,
			`Harbor smoke task ${smokeTask} completed without a quest-headless-output.json artifact.`,
		);
		return {
			name: "harbor-smoke",
			ok: false,
			detail: debug.detail,
			jobDir,
			artifactPath: debug.artifactPath,
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
				detail: `Harbor smoke task ${smokeTask} completed and produced Quest JSON in ${basename(jobDir)}.\nJob dir: ${jobDir}`,
				jobDir,
				artifactPath: outputPath,
			};
		}
	}
	const debug = await withSmokeDebugDetail(
		jobDir,
		`Harbor smoke task ${smokeTask} ran, but no quest-headless-output.json artifact reported a completed Quest run.`,
	);
	return {
		name: "harbor-smoke",
		ok: false,
		detail: debug.detail,
		jobDir,
		artifactPath: debug.artifactPath,
	};
}

function summarizeChecks(model: string, checks: CheckResult[]): string {
	const passed = checks.filter((check) => check.ok).length;
	const total = checks.length;
	const failedNames = checks.filter((check) => !check.ok).map((check) => check.name);
	if (failedNames.length === 0) {
		return `Harbor preflight passed ${passed}/${total} checks for ${model}.`;
	}
	return `Harbor preflight failed ${failedNames.length}/${total} checks for ${model}: ${failedNames.join(", ")}.`;
}

export function deriveNextSteps(
	checks: CheckResult[],
	smokeTask: string,
	jobsDir: string,
	skipSmoke: boolean,
): string[] {
	const failed = checks.filter((check) => !check.ok);
	if (failed.length === 0) {
		return skipSmoke
			? [`Run npm run internal:benchmark:tbench:preflight -- --smoke-task ${smokeTask} before moving on to sample runs.`]
			: ["Run npm run internal:benchmark:tbench:sample for a broader benchmark pass."];
	}
	const steps: string[] = [];
	const smokeFailure = failed.find((check) => check.name === "harbor-smoke");
	const integrityFailure = failed.find((check) => check.name === "harbor-integrity");
	const smokeSuccess = checks.find((check) => check.name === "harbor-smoke" && check.ok);
	const prerequisiteFailures = failed.filter((check) => check.name !== "harbor-smoke" && check.name !== "harbor-integrity");
	if (smokeFailure?.jobDir) {
		steps.push(`Inspect the latest Harbor smoke run under ${smokeFailure.jobDir}.`);
	}
	if (smokeFailure?.artifactPath) {
		steps.push(`Open ${smokeFailure.artifactPath} for the closest failure context.`);
	}
	if (prerequisiteFailures.length > 0) {
		steps.push(`Fix the failed prerequisite checks, then rerun npm run internal:benchmark:tbench:preflight -- --smoke-task ${smokeTask}.`);
	}
	if (integrityFailure) {
		if (smokeSuccess?.jobDir) {
			steps.push(`Harbor smoke already succeeded in ${smokeSuccess.jobDir}; treat this as a trust failure, not a smoke failure.`);
		}
		const issueCodes = Array.isArray(integrityFailure.context?.issueCodes) ? integrityFailure.context.issueCodes.join(", ") : "";
		if (issueCodes) {
			steps.push(`Capture the Harbor integrity issue codes for upstream follow-up: ${issueCodes}.`);
		}
		steps.push("Do not trust Terminal-Bench scores until Harbor verifier isolation is fixed.");
	}
	if (!smokeFailure) {
		steps.push(`Latest Harbor preflight jobs root: ${jobsDir}`);
	}
	return [...new Set(steps)];
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

async function runHarborIntegrityCheck(): Promise<CheckResult> {
	const report = await inspectHarborInstallation();
	const evidenceLines = [
		report.evidence.trialExecuteAgentSnippet ? `Trial._execute_agent:\n${report.evidence.trialExecuteAgentSnippet}` : "",
		report.evidence.verifierVerifySnippet ? `Verifier.verify:\n${report.evidence.verifierVerifySnippet}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return {
		name: "harbor-integrity",
		ok: report.ok,
		detail: [report.summary, evidenceLines].filter(Boolean).join("\n"),
		context: {
			issueCodes: report.issues.map((issue) => issue.code),
			evidence: report.evidence,
		},
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { model } = options;
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const jobsDir = options.jobsDir ?? resolve(rootDir, "benchmarks", ".runs", "harbor", "preflight-smoke");
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
					jobDir: jobsDir,
				});
			} else {
				checks.push(await runHarborSmoke(rootDir, model, options.smokeTask, jobsDir, bundle));
			}
		}
		checks.push(await runHarborIntegrityCheck());
	} finally {
		await bundle.cleanup();
	}
	const failed = checks.filter((check) => !check.ok);
	console.log(
		JSON.stringify(
			{
				model,
				smokeTask: options.smokeTask,
				jobsDir,
				checks,
				ok: failed.length === 0,
				summary: summarizeChecks(model, checks),
				nextSteps: deriveNextSteps(checks, options.smokeTask, jobsDir, options.skipSmoke),
			},
			null,
			2,
		),
	);
	process.exitCode = failed.length === 0 ? 0 : 1;
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
