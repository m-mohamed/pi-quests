import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { defaultBenchmarkModel, missingEnvVarsForModel } from "../shared.js";

interface OfficialRunOptions {
	repo: string;
	problem: string;
	model: string;
	environment: string;
	dryRun: boolean;
}

function usage(): string {
	return "Usage: node --import tsx benchmarks/slopcodebench/official-run.ts --problem <problem> [--repo <path>] [--model <provider/model>] [--environment <name>] [--dry-run]";
}

function parseArgs(argv: string[]): OfficialRunOptions {
	const problemIndex = argv.indexOf("--problem");
	if (problemIndex < 0 || !argv[problemIndex + 1]) {
		throw new Error(usage());
	}
	const repoIndex = argv.indexOf("--repo");
	const modelIndex = argv.indexOf("--model");
	const envIndex = argv.indexOf("--environment");
	return {
		repo: repoIndex >= 0 && argv[repoIndex + 1] ? resolve(argv[repoIndex + 1]) : resolve(process.env.SLOPCODEBENCH_REPO ?? "/tmp/slop-code-bench"),
		problem: argv[problemIndex + 1],
		model: modelIndex >= 0 && argv[modelIndex + 1] ? argv[modelIndex + 1] : defaultBenchmarkModel(),
		environment: envIndex >= 0 && argv[envIndex + 1] ? argv[envIndex + 1] : "local-py",
		dryRun: argv.includes("--dry-run"),
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const missing = missingEnvVarsForModel(options.model);
	if (missing.length > 0) {
		throw new Error(`Missing credentials for ${options.model}. Expected one of: ${missing.join(", ")}`);
	}
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const overlayDir = resolve(rootDir, "benchmarks", "slopcodebench", "official-overlay");
	const outputDir = resolve(rootDir, "benchmarks", ".runs", "slopcodebench", "official");
	await mkdir(outputDir, { recursive: true });

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
		"--problem",
		options.problem,
		`save_dir=${outputDir}`,
	];
	if (options.dryRun) args.push("--dry-run");

	const envVars: Record<string, string> = {};
	const authFile = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(authFile)) {
		try {
			const auth = JSON.parse(readFileSync(authFile, "utf-8"));
			let opencodeKey = auth?.["opencode-go"]?.key;
			if (opencodeKey && opencodeKey.startsWith("!")) {
				opencodeKey = execSync(opencodeKey.slice(1), { encoding: "utf-8" }).trim();
			}
			if (opencodeKey) envVars.OPENCODE_API_KEY = opencodeKey;
		} catch {
			// auth.json not readable
		}
	}

	const command = {
		command: "uv",
		args,
		cwd: options.repo,
		env: {
			...process.env,
			...envVars,
			PYTHONPATH: [overlayDir, resolve(options.repo, "src"), process.env.PYTHONPATH].filter(Boolean).join(":"),
			SLOPCODEBENCH_QUEST_BIN: `${process.execPath} ${resolve(rootDir, "bin", "quest-headless.mjs")}`,
		},
	};

	await writeFile(
		join(outputDir, `invocation-${Date.now()}.json`),
		`${JSON.stringify(
			{
				repo: options.repo,
				problem: options.problem,
				model: options.model,
				environment: options.environment,
				dryRun: options.dryRun,
				command: [command.command, ...command.args],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);

	if (options.dryRun) {
		console.log(JSON.stringify(command, null, 2));
		return;
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
}

await main();
