import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { credentialsAvailableForModel, defaultBenchmarkModel, requiredEnvVarsForModel } from "../shared.js";

const BUNDLED_PI_BIN = "/opt/quest-package/node_modules/.bin/pi";
const DEFAULT_BUNDLED_PI_VERSION = "0.65.2";
const BUNDLED_NODE_VERSION = "20.18.3";
const BUNDLED_NODE_RUNTIME_DIR = "/opt/quest-node-runtimes";
const LINUX_NODE_ARCHES = ["x64", "arm64"] as const;
const HARBOR_NODE_ARCHES_ENV = "PI_QUESTS_HARBOR_NODE_ARCHES";

type LinuxNodeArch = (typeof LINUX_NODE_ARCHES)[number];

export interface HarborRunOptions {
	dataset: string;
	runMode: string;
	model?: string;
	dryRun?: boolean;
	bundlePath?: string;
	nodeRuntimePath?: string;
	authDir?: string | null;
	jobsDir?: string;
	profileId?: string;
	includeTaskNames?: string[];
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
	for (const taskName of options.includeTaskNames ?? []) {
		if (taskName.trim()) args.push("--include-task-name", taskName);
	}
	if (options.bundlePath) {
		const mounts = [`${options.bundlePath}:/opt/quest-package:ro`];
		if (options.nodeRuntimePath) mounts.push(`${options.nodeRuntimePath}:${BUNDLED_NODE_RUNTIME_DIR}:ro`);
		const authDir = options.authDir === undefined ? join(homedir(), ".pi", "agent") : options.authDir;
		if (authDir && existsSync(authDir)) mounts.push(`${authDir}:/root/.pi/agent`);
		args.push("--mounts-json", JSON.stringify(mounts));
		args.push("--ae", "QUEST_PACKAGE_DIR=/opt/quest-package");
		if (options.nodeRuntimePath) args.push("--ae", `QUEST_NODE_RUNTIME_DIR=${BUNDLED_NODE_RUNTIME_DIR}`);
		args.push("--ae", `PI_QUESTS_PI_BIN=${BUNDLED_PI_BIN}`);
	}
	args.push("--ae", `QUEST_HARBOR_DATASET=${options.dataset}`);
	args.push("--ae", `QUEST_HARBOR_RUN_MODE=${options.runMode}`);
	if (options.profileId?.trim()) args.push("--ae", `QUEST_HARBOR_PROFILE_ID=${options.profileId}`);
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
	const jobsDirIndex = argv.indexOf("--jobs-dir");
	const profileIndex = argv.indexOf("--profile");
	const includeTaskNames: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--include-task-name" && argv[index + 1]) {
			includeTaskNames.push(argv[index + 1]);
		}
	}
	return {
		dataset: argv[datasetIndex + 1],
		runMode: runModeIndex >= 0 ? argv[runModeIndex + 1] : "custom",
		model: modelIndex >= 0 ? argv[modelIndex + 1] : undefined,
		dryRun: argv.includes("--dry-run"),
		jobsDir: jobsDirIndex >= 0 ? resolve(argv[jobsDirIndex + 1]) : undefined,
		profileId: profileIndex >= 0 ? argv[profileIndex + 1] : undefined,
		includeTaskNames,
		maxTasks: maxTasksIndex >= 0 ? Number(argv[maxTasksIndex + 1]) : undefined,
		nConcurrent: nConcurrentIndex >= 0 ? Number(argv[nConcurrentIndex + 1]) : undefined,
		agentSetupTimeoutMultiplier:
			setupTimeoutMultiplierIndex >= 0 ? Number(argv[setupTimeoutMultiplierIndex + 1]) : undefined,
	};
}

function bundledPiVersion(): string {
	const explicit = process.env.PI_QUESTS_PI_VERSION?.trim();
	if (explicit) return explicit;
	try {
		const detected = execSync("pi --version", {
			cwd: process.cwd(),
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.replace(/^v/i, "");
		return detected || DEFAULT_BUNDLED_PI_VERSION;
	} catch {
		return DEFAULT_BUNDLED_PI_VERSION;
	}
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
	const proc = spawn(command, args, {
		cwd,
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
		throw new Error(`${command} ${args.join(" ")} failed.\n${stderr || stdout}`);
	}
}

function linuxNodeArchiveName(arch: LinuxNodeArch): string {
	return `node-v${BUNDLED_NODE_VERSION}-linux-${arch}.tar.xz`;
}

function linuxNodeExtractedDirName(arch: LinuxNodeArch): string {
	return `node-v${BUNDLED_NODE_VERSION}-linux-${arch}`;
}

export function bundledLinuxNodeArchitectures(): LinuxNodeArch[] {
	const override = process.env[HARBOR_NODE_ARCHES_ENV]
		?.split(",")
		.map((value) => value.trim())
		.filter((value): value is LinuxNodeArch => (LINUX_NODE_ARCHES as readonly string[]).includes(value));
	if (override?.length) return [...new Set(override)];
	return [...LINUX_NODE_ARCHES];
}

async function writeDownloadedFile(url: string, destination: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	const output = createWriteStream(destination);
	await pipeline(Readable.fromWeb(response.body as globalThis.ReadableStream), output);
}

async function ensureBundledLinuxNodeRuntime(arch: LinuxNodeArch): Promise<string> {
	const cacheRoot = join(homedir(), ".cache", "pi-quests", "harbor-node");
	const runtimeDir = join(cacheRoot, `node-linux-${arch}`);
	const nodeBin = join(runtimeDir, "bin", "node");
	if (existsSync(nodeBin)) return runtimeDir;
	await mkdir(cacheRoot, { recursive: true });
	const archivePath = join(cacheRoot, linuxNodeArchiveName(arch));
	if (!existsSync(archivePath)) {
		const nodeUrl = `https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/${linuxNodeArchiveName(arch)}`;
		await writeDownloadedFile(nodeUrl, archivePath);
	}
	const extractRoot = await mkdtemp(join(cacheRoot, `extract-${arch}-`));
	try {
		await runCommand("tar", ["-xJf", archivePath, "-C", extractRoot], cacheRoot);
		const extractedDir = join(extractRoot, linuxNodeExtractedDirName(arch));
		const extractedNode = join(extractedDir, "bin", "node");
		if (!existsSync(extractedNode)) {
			throw new Error(`Bundled Linux Node archive for ${arch} did not contain ${extractedNode}`);
		}
		await rm(runtimeDir, { recursive: true, force: true });
		await cp(extractedDir, runtimeDir, { recursive: true });
	} finally {
		await rm(extractRoot, { recursive: true, force: true });
	}
	return runtimeDir;
}

export async function materializeQuestBundle(
	rootDir: string,
): Promise<{ bundlePath: string; nodeRuntimePath: string; authDir: string | null; piVersion: string; cleanup(): Promise<void> }> {
	const outputDir = await mkdtemp(join(tmpdir(), "quest-harbor-pack-"));
	const bundlePath = join(outputDir, "bundle");
	const distPath = join(bundlePath, "dist");
	const agentPath = join(outputDir, "pi-agent");
	await mkdir(distPath, { recursive: true });
	const piVersion = bundledPiVersion();
	const hostAgentPath = join(homedir(), ".pi", "agent");
	const authDir = existsSync(hostAgentPath) ? agentPath : null;
	if (authDir) await cp(hostAgentPath, authDir, { recursive: true });
	await writeFile(
		join(bundlePath, "package.json"),
		`${JSON.stringify({ type: "module", private: true, name: "quest-harbor-bundle" }, null, 2)}\n`,
		"utf-8",
	);
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
	await runCommand("npx", ["tsc", "-p", tsconfigPath], rootDir);
	await runCommand(
		"npm",
		[
			"install",
			"--prefix",
			bundlePath,
			"--omit=dev",
			"--no-fund",
			"--no-audit",
			`@mariozechner/pi-coding-agent@${piVersion}`,
		],
		rootDir,
	);
	await runCommand(join(bundlePath, "node_modules", ".bin", "pi"), ["--version"], rootDir);
	const nodeRuntimeRoot = join(outputDir, "node-runtimes");
	await mkdir(nodeRuntimeRoot, { recursive: true });
	for (const arch of bundledLinuxNodeArchitectures()) {
		const cachedRuntimeDir = await ensureBundledLinuxNodeRuntime(arch);
		await cp(cachedRuntimeDir, join(nodeRuntimeRoot, `node-linux-${arch}`), { recursive: true });
	}
	return {
		bundlePath,
		nodeRuntimePath: nodeRuntimeRoot,
		authDir,
		piVersion,
		async cleanup() {
			await rm(outputDir, { recursive: true, force: true });
		},
	};
}

async function writeInvocationSummary(
	rootDir: string,
	options: HarborRunOptions,
	command: ReturnType<typeof buildHarborCommand>,
	bundledPiVersion?: string,
) {
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
		profileId: options.profileId ?? null,
		includeTaskNames: options.includeTaskNames ?? [],
		maxTasks: options.maxTasks ?? null,
		nConcurrent: options.nConcurrent ?? 1,
		agentSetupTimeoutMultiplier: options.agentSetupTimeoutMultiplier ?? 4,
		bundlePath: options.bundlePath ?? null,
		nodeRuntimePath: options.nodeRuntimePath ?? null,
		bundledPiVersion: bundledPiVersion ?? null,
		agentEnvKeys,
		command: [command.command, ...command.args],
	};
	await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const model = options.model ?? defaultBenchmarkModel();
	const credentials = credentialsAvailableForModel(model);
	if (!credentials.ok) {
		throw new Error(credentials.detail);
	}
	const rootDir = resolve(dirname(dirname(fileURLToPath(import.meta.url))), "..");
	const bundle = await materializeQuestBundle(rootDir);
	const previousVersion = process.env.PI_QUESTS_PI_VERSION;
	process.env.PI_QUESTS_PI_VERSION = bundle.piVersion;
	try {
		const command = buildHarborCommand({
			...options,
			model,
			bundlePath: bundle.bundlePath,
			nodeRuntimePath: bundle.nodeRuntimePath,
			authDir: bundle.authDir,
		});
		await writeInvocationSummary(
			rootDir,
			{
				...options,
				model,
				bundlePath: bundle.bundlePath,
				nodeRuntimePath: bundle.nodeRuntimePath,
				authDir: bundle.authDir,
			},
			command,
			bundle.piVersion,
		);
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
		if (previousVersion === undefined) delete process.env.PI_QUESTS_PI_VERSION;
		else process.env.PI_QUESTS_PI_VERSION = previousVersion;
		await bundle.cleanup();
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
