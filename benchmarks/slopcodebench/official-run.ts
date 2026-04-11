import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultBenchmarkModel, missingEnvVarsForModel } from "../shared.js";

export interface OfficialRunOptions {
	repo: string;
	problems: string[];
	model: string;
	environment: string;
	dryRun: boolean;
	outputDir: string;
}

interface OfficialCommand {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	outputDir: string;
}

function usage(): string {
	return "Usage: node --import tsx benchmarks/slopcodebench/official-run.ts --problem <problem> [--problem <problem> ...] [--repo <path>] [--model <provider/model>] [--environment <name>] [--output-dir <path>] [--dry-run]";
}

function rootDir(): string {
	return resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
}

function defaultOutputDir(): string {
	return resolve(rootDir(), "benchmarks", ".runs", "slopcodebench", "official");
}

export function resolveSlopCodeBenchRepo(explicitRepo?: string): string {
	const candidate = explicitRepo?.trim() || process.env.SLOPCODEBENCH_REPO?.trim() || (existsSync("/tmp/slop-code-bench") ? "/tmp/slop-code-bench" : "");
	if (!candidate) {
		throw new Error("SlopCodeBench repo not found. Pass --repo <path>, set SLOPCODEBENCH_REPO, or create /tmp/slop-code-bench.");
	}
	const resolved = resolve(candidate);
	if (!existsSync(resolved)) {
		throw new Error(`SlopCodeBench repo does not exist: ${resolved}`);
	}
	return resolved;
}

function parseArgs(argv: string[]): OfficialRunOptions {
	const problems: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--problem" && argv[index + 1]) {
			problems.push(argv[index + 1]);
			index += 1;
		}
	}
	if (problems.length === 0) throw new Error(usage());
	const repoIndex = argv.indexOf("--repo");
	const modelIndex = argv.indexOf("--model");
	const envIndex = argv.indexOf("--environment");
	const outputDirIndex = argv.indexOf("--output-dir");
	return {
		repo: resolveSlopCodeBenchRepo(repoIndex >= 0 ? argv[repoIndex + 1] : undefined),
		problems,
		model: modelIndex >= 0 && argv[modelIndex + 1] ? argv[modelIndex + 1] : defaultBenchmarkModel(),
		environment: envIndex >= 0 && argv[envIndex + 1] ? argv[envIndex + 1] : "local-py",
		dryRun: argv.includes("--dry-run"),
		outputDir: outputDirIndex >= 0 && argv[outputDirIndex + 1] ? resolve(argv[outputDirIndex + 1]) : defaultOutputDir(),
	};
}

function authEnvironment(): Record<string, string> {
	const envVars: Record<string, string> = {};
	const authFile = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authFile)) return envVars;
	try {
		const auth = JSON.parse(readFileSync(authFile, "utf-8"));
		const zaiKey = auth?.["zai"]?.key;
		if (zaiKey) envVars.ZAI_API_KEY = zaiKey;
		const codexToken = auth?.["openai-codex"]?.access;
		if (codexToken) envVars.OPENAI_API_KEY = codexToken;
	} catch {
		// auth.json not readable
	}
	return envVars;
}

export function buildOfficialSlopCodeBenchCommand(options: OfficialRunOptions): OfficialCommand {
	const repoRoot = rootDir();
	const overlayDir = resolve(repoRoot, "benchmarks", "slopcodebench", "official-overlay");
	const args = [
		"run",
		"slop-code",
		"run",
		"--agent",
		join(overlayDir, "quest.yaml"),
		"--environment",
		options.environment,
		"--model",
		options.model,
	];
	for (const problem of options.problems) {
		args.push("--problem", problem);
	}
	args.push(`save_dir=${options.outputDir}`);
	if (options.dryRun) args.push("--dry-run");
	return {
		command: "uv",
		args,
		cwd: options.repo,
		env: {
			...process.env,
			...authEnvironment(),
			PI_QUESTS_INTERNAL: "1",
			PYTHONPATH: [overlayDir, resolve(options.repo, "src"), process.env.PYTHONPATH].filter(Boolean).join(":"),
			SLOPCODEBENCH_QUEST_BIN: `${process.execPath} ${resolve(repoRoot, "bin", "quest-headless.mjs")}`,
		},
		outputDir: options.outputDir,
	};
}

async function writeInvocationSummary(options: OfficialRunOptions, command: OfficialCommand): Promise<void> {
	await mkdir(options.outputDir, { recursive: true });
	await writeFile(
		join(options.outputDir, `invocation-${Date.now()}.json`),
		`${JSON.stringify(
			{
				repo: options.repo,
				problems: options.problems,
				model: options.model,
				environment: options.environment,
				dryRun: options.dryRun,
				outputDir: options.outputDir,
				command: [command.command, ...command.args],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
}

async function findLatestRunRoot(outputDir: string): Promise<string | null> {
	let latest: { dir: string; mtimeMs: number } | null = null;
	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const next = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(next);
				continue;
			}
			if (!entry.isFile() || entry.name !== "result.json") continue;
			const info = await stat(next);
			if (!latest || info.mtimeMs >= latest.mtimeMs) latest = { dir: dirname(next), mtimeMs: info.mtimeMs };
		}
	}
	if (!existsSync(outputDir)) return null;
	await walk(outputDir);
	return latest?.dir ?? null;
}

export async function runOfficialSlopCodeBench(options: OfficialRunOptions): Promise<{ runRoot: string | null; command: OfficialCommand }> {
	const command = buildOfficialSlopCodeBenchCommand(options);
	await writeInvocationSummary(options, command);
	if (options.dryRun) {
		return { runRoot: null, command };
	}
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(command.command, command.args, {
			cwd: command.cwd,
			env: command.env,
			stdio: "inherit",
		});
		proc.on("close", (code) => {
			if ((code ?? 1) === 0) {
				resolvePromise();
				return;
			}
			reject(new Error(`slop-code exited with code ${code ?? 1}`));
		});
		proc.on("error", reject);
	});
	return {
		runRoot: await findLatestRunRoot(options.outputDir),
		command,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.dryRun) {
		const missing = missingEnvVarsForModel(options.model);
		if (missing.length > 0) {
			throw new Error(`Missing credentials for ${options.model}. Expected one of: ${missing.join(", ")}`);
		}
	}
	const result = await runOfficialSlopCodeBench(options);
	if (options.dryRun) {
		console.log(JSON.stringify(result.command, null, 2));
		return;
	}
	console.log(JSON.stringify({ outputDir: options.outputDir, runRoot: result.runRoot }, null, 2));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
	await main();
}
