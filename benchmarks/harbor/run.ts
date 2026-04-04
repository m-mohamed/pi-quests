import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBenchmarkModel, missingEnvVarsForModel, requiredEnvVarsForModel } from "../shared.js";

export interface HarborRunOptions {
	dataset: string;
	runMode: string;
	model?: string;
	dryRun?: boolean;
	bundlePath?: string;
	jobsDir?: string;
	maxTasks?: number;
	nConcurrent?: number;
	agentSetupTimeoutMultiplier?: number;
}

export function buildHarborCommand(options: HarborRunOptions): { command: string; args: string[]; env: Record<string, string> } {
	const cwd = resolve(process.cwd());
	const model = options.model ?? defaultBenchmarkModel();
	const jobsDir = options.jobsDir ?? resolve(cwd, "benchmarks", ".runs", "harbor", options.runMode);
	const args = [
		"run",
		"--yes",
		"-d",
		options.dataset,
		"--agent-import-path",
		"benchmarks.harbor.quest_installed_agent:QuestInstalledAgent",
		"-m",
		model,
		"-o",
		jobsDir,
		"--artifact",
		"/logs/agent/quest-headless-output.json",
		"--artifact",
		"/logs/agent/quest-headless-stderr.log",
		"--artifact",
		"/workspace/.pi",
	];
	const nConcurrent = options.nConcurrent ?? 1;
	if (Number.isFinite(nConcurrent) && nConcurrent > 0) args.push("-n", String(nConcurrent));
	const setupTimeoutMultiplier = options.agentSetupTimeoutMultiplier ?? 4;
	if (Number.isFinite(setupTimeoutMultiplier) && setupTimeoutMultiplier > 0) {
		args.push("--agent-setup-timeout-multiplier", String(setupTimeoutMultiplier));
	}
	if (options.maxTasks && Number.isFinite(options.maxTasks) && options.maxTasks > 0) args.push("-l", String(options.maxTasks));
	if (options.bundlePath) {
		const mounts = [`${options.bundlePath}:/opt/quest-package:ro`];
		const authFile = join(homedir(), ".pi", "agent", "auth.json");
		if (existsSync(authFile)) {
			try {
				const auth = JSON.parse(readFileSync(authFile, "utf-8"));
				// Extract OpenCode Go API key
				let opencodeKey = auth?.["opencode-go"]?.key;
				if (opencodeKey && opencodeKey.startsWith("!")) {
					opencodeKey = execSync(opencodeKey.slice(1), { encoding: "utf-8" }).trim();
				}
				if (opencodeKey) args.push("--ae", `OPENCODE_API_KEY=${opencodeKey}`);
				// Extract Codex OAuth access token
				const codexToken = auth?.["openai-codex"]?.access;
				if (codexToken) args.push("--ae", `OPENAI_API_KEY=${codexToken}`);
			} catch {
				// auth.json not readable — model credentials may fail inside the container
			}
		}
		args.push("--mounts-json", JSON.stringify(mounts));
		args.push("--ae", "QUEST_PACKAGE_DIR=/opt/quest-package");
	}
	args.push("--ae", `QUEST_HARBOR_DATASET=${options.dataset}`);
	args.push("--ae", `QUEST_HARBOR_RUN_MODE=${options.runMode}`);
	for (const name of requiredEnvVarsForModel(model)) {
		const value = process.env[name];
		if (value?.trim()) args.push("--ae", `${name}=${value}`);
	}
	return {
		command: "harbor",
		args,
		env: {
			PYTHONPATH: [cwd, process.env.PYTHONPATH].filter(Boolean).join(":"),
			QUEST_HARBOR_DATASET: options.dataset,
			QUEST_HARBOR_RUN_MODE: options.runMode,
		},
	};
}

function parseArgs(argv: string[]): HarborRunOptions {
	const datasetIndex = argv.indexOf("--dataset");
	if (datasetIndex < 0 || !argv[datasetIndex + 1]) {
		throw new Error(
			"Usage: node --import tsx benchmarks/harbor/run.ts --dataset <dataset> [--run-mode <mode>] [--model <provider/model>] [--dry-run]",
		);
	}
	const runModeIndex = argv.indexOf("--run-mode");
	const modelIndex = argv.indexOf("--model");
	const maxTasksIndex = argv.indexOf("--max-tasks");
	const nConcurrentIndex = argv.indexOf("--n-concurrent");
	const setupTimeoutMultiplierIndex = argv.indexOf("--agent-setup-timeout-multiplier");
	return {
		dataset: argv[datasetIndex + 1],
		runMode: runModeIndex >= 0 ? argv[runModeIndex + 1] : "custom",
		model: modelIndex >= 0 ? argv[modelIndex + 1] : undefined,
		dryRun: argv.includes("--dry-run"),
		maxTasks: maxTasksIndex >= 0 ? Number(argv[maxTasksIndex + 1]) : undefined,
		nConcurrent: nConcurrentIndex >= 0 ? Number(argv[nConcurrentIndex + 1]) : undefined,
		agentSetupTimeoutMultiplier:
			setupTimeoutMultiplierIndex >= 0 ? Number(argv[setupTimeoutMultiplierIndex + 1]) : undefined,
	};
}

async function materializeQuestBundle(rootDir: string): Promise<{ bundlePath: string; cleanup(): Promise<void> }> {
	const outputDir = await mkdtemp(join(tmpdir(), "quest-harbor-pack-"));
	const bundlePath = join(outputDir, "bundle");
	const distPath = join(bundlePath, "dist");
	await mkdir(distPath, { recursive: true });
	const tsconfigPath = join(outputDir, "tsconfig.harbor.json");
	await writeFile(
		tsconfigPath,
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					verbatimModuleSyntax: true,
					skipLibCheck: true,
					noEmit: false,
					outDir: distPath,
					rootDir: resolve(rootDir, "src"),
					baseUrl: rootDir,
					types: [],
					allowImportingTsExtensions: false,
					paths: {
						"@mariozechner/pi-ai": ["./types/pi-ai.d.ts"],
						"@mariozechner/pi-coding-agent": ["./types/pi-coding-agent.d.ts"],
						"@mariozechner/pi-tui": ["./types/pi-tui.d.ts"],
						"@sinclair/typebox": ["./types/external-shims.d.ts"],
					},
				},
				include: [resolve(rootDir, "src", "**", "*.ts"), resolve(rootDir, "types", "**", "*.d.ts")],
				exclude: [
					resolve(rootDir, "src", "evals-core.ts"),
					resolve(rootDir, "scripts", "**"),
					resolve(rootDir, "tests", "**"),
				],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	const proc = spawn("npx", ["tsc", "-p", tsconfigPath], {
		cwd: rootDir,
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
	const exitCode = await new Promise<number>((resolvePromise, reject) => {
		proc.on("close", (code) => resolvePromise(code ?? 1));
		proc.on("error", reject);
	});
	if (exitCode !== 0) {
		throw new Error(`Failed to compile the Quest Harbor bundle.\n${stderr || stdout}`);
	}
	await writeFile(join(bundlePath, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf-8");
	return {
		bundlePath,
		async cleanup() {
			await rm(outputDir, { recursive: true, force: true });
		},
	};
}

async function writeInvocationSummary(rootDir: string, options: HarborRunOptions, command: ReturnType<typeof buildHarborCommand>) {
	const outputDir = resolve(rootDir, "benchmarks", ".runs", "harbor");
	await mkdir(outputDir, { recursive: true });
	const file = join(outputDir, `invocation-${Date.now()}.json`);
	const agentEnvKeys = command.args
		.flatMap((value, index, parts) => (value === "--ae" ? [parts[index + 1]?.split("=")[0] ?? ""] : []))
		.filter(Boolean);
	const payload = {
		dataset: options.dataset,
		runMode: options.runMode,
		model: options.model ?? defaultBenchmarkModel(),
		jobsDir: options.jobsDir ?? resolve(rootDir, "benchmarks", ".runs", "harbor", options.runMode),
		maxTasks: options.maxTasks ?? null,
		nConcurrent: options.nConcurrent ?? 1,
		agentSetupTimeoutMultiplier: options.agentSetupTimeoutMultiplier ?? 4,
		bundlePath: options.bundlePath ?? null,
		agentEnvKeys,
		command: [command.command, ...command.args],
	};
	await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const model = options.model ?? defaultBenchmarkModel();
	const missing = missingEnvVarsForModel(model);
	if (missing.length > 0) {
		throw new Error(`Missing credentials for ${model}. Expected one of: ${missing.join(", ")}`);
	}
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const bundle = await materializeQuestBundle(rootDir);
	try {
		const command = buildHarborCommand({
			...options,
			model,
			bundlePath: bundle.bundlePath,
		});
		await writeInvocationSummary(rootDir, { ...options, model, bundlePath: bundle.bundlePath }, command);
		if (options.dryRun) {
			console.log(JSON.stringify(command, null, 2));
			return;
		}
		await new Promise<void>((resolvePromise, reject) => {
			const proc = spawn(command.command, command.args, {
				stdio: "inherit",
				env: {
					...process.env,
					...command.env,
				},
			});
			proc.on("close", (code) => {
				if ((code ?? 1) === 0) {
					resolvePromise();
					return;
				}
				reject(new Error(`Harbor exited with code ${code ?? 1}`));
			});
			proc.on("error", reject);
		});
	} finally {
		await bundle.cleanup();
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
