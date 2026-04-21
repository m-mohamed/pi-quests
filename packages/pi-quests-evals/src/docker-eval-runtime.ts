import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUNDLED_PI_VERSION = "0.68.0";
const BUNDLED_NODE_VERSION = "22.17.1";
const LINUX_NODE_ARCHES = ["x64", "arm64"] as const;
const NODE_ARCH_ENV = "PI_QUESTS_DOCKER_EVAL_NODE_ARCHES";

type LinuxNodeArch = (typeof LINUX_NODE_ARCHES)[number];

interface RootPackageJson {
	dependencies?: Record<string, string>;
}

interface RuntimeDependency {
	name: string;
	version: string;
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

function bundledLinuxNodeArchitectures(): LinuxNodeArch[] {
	const override = process.env[NODE_ARCH_ENV]
		?.split(",")
		.map((value) => value.trim())
		.filter((value): value is LinuxNodeArch => (LINUX_NODE_ARCHES as readonly string[]).includes(value));
	if (override?.length) return [...new Set(override)];
	return [...LINUX_NODE_ARCHES];
}

async function writeDownloadedFile(url: string, destination: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	const payload = Buffer.from(await response.arrayBuffer());
	await writeFile(destination, payload);
}

async function ensureBundledLinuxNodeRuntime(arch: LinuxNodeArch): Promise<string> {
	const cacheRoot = join(homedir(), ".cache", "pi-quests", "docker-eval-node");
	const runtimeDir = join(cacheRoot, `node-linux-${arch}`);
	const nodeBin = join(runtimeDir, "bin", "node");
	if (existsSync(nodeBin)) return runtimeDir;
	await mkdir(cacheRoot, { recursive: true });
	const archivePath = join(cacheRoot, linuxNodeArchiveName(arch));
	if (!existsSync(archivePath)) {
		await writeDownloadedFile(
			`https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/${linuxNodeArchiveName(arch)}`,
			archivePath,
		);
	}
	const extractRoot = await mkdtemp(join(cacheRoot, `extract-${arch}-`));
	try {
		await runCommand("tar", ["-xJf", archivePath, "-C", extractRoot], cacheRoot);
		const extractedDir = join(extractRoot, linuxNodeExtractedDirName(arch));
		if (!existsSync(join(extractedDir, "bin", "node"))) {
			throw new Error(`Bundled Linux Node archive for ${arch} did not contain a node binary.`);
		}
		await rm(runtimeDir, { recursive: true, force: true });
		await cp(extractedDir, runtimeDir, { recursive: true });
	} finally {
		await rm(extractRoot, { recursive: true, force: true });
	}
	return runtimeDir;
}

async function loadRuntimeDependencies(): Promise<RuntimeDependency[]> {
	const packageJson = JSON.parse(
		await readFile(join(PACKAGE_ROOT, "package.json"), "utf-8"),
	) as RootPackageJson;
	return Object.entries(packageJson.dependencies ?? {})
		.filter(([name]) => name !== "tsx")
		.map(([name, version]) => ({ name, version }));
}

function packWorkspacePackage(packageDir: string, outputDir: string): string {
	const filename = execSync(`npm pack --pack-destination ${JSON.stringify(outputDir)}`, {
		cwd: packageDir,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	})
		.trim()
		.split("\n")
		.pop();
	if (!filename) {
		throw new Error(`Failed to pack workspace package at ${packageDir}.`);
	}
	return join(outputDir, filename);
}

export function detectLinuxNodeArch(): LinuxNodeArch {
	if (process.arch === "arm64") return "arm64";
	return "x64";
}

export interface MaterializedQuestBundle {
	bundlePath: string;
	nodeRuntimeRoot: string;
	authDir: string | null;
	piVersion: string;
	cleanup(): Promise<void>;
}

export async function materializeQuestBundle(rootDir = PACKAGE_ROOT): Promise<MaterializedQuestBundle> {
	const outputDir = await mkdtemp(join(tmpdir(), "quest-docker-eval-pack-"));
	const bundlePath = join(outputDir, "bundle");
	const distPath = join(bundlePath, "dist");
	const agentPath = join(outputDir, "pi-agent");
	await mkdir(distPath, { recursive: true });

	const piVersion = bundledPiVersion();
	const hostAgentPath = join(homedir(), ".pi", "agent");
	const authDir = existsSync(hostAgentPath) ? agentPath : null;
	if (authDir) {
		await cp(hostAgentPath, authDir, { recursive: true });
	}

	await writeFile(
		join(bundlePath, "package.json"),
		`${JSON.stringify({ type: "module", private: true, name: "quest-docker-eval-bundle" }, null, 2)}\n`,
		"utf-8",
	);
	const tsconfigPath = join(outputDir, "tsconfig.docker-eval.json");
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
					types: [],
					allowImportingTsExtensions: false,
				},
				include: [resolve(rootDir, "src", "**", "*.ts")],
				exclude: [resolve(rootDir, "scripts", "**"), resolve(rootDir, "tests", "**")],
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	await runCommand("npx", ["tsc", "-p", tsconfigPath], rootDir);

	const runtimeDeps = await loadRuntimeDependencies();
	const bundledDependencyArgs = runtimeDeps.map(({ name, version }) => {
		if (name === "@m-mohamed/pi-quests-core") {
			const corePackageDir = resolve(PACKAGE_ROOT, "..", "pi-quests-core");
			return packWorkspacePackage(corePackageDir, outputDir);
		}
		return `${name}@${version}`;
	});
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
			...bundledDependencyArgs,
		],
		rootDir,
	);

	const nodeRuntimeRoot = join(outputDir, "node-runtimes");
	await mkdir(nodeRuntimeRoot, { recursive: true });
	for (const arch of bundledLinuxNodeArchitectures()) {
		const cachedRuntimeDir = await ensureBundledLinuxNodeRuntime(arch);
		await cp(cachedRuntimeDir, join(nodeRuntimeRoot, `node-linux-${arch}`), { recursive: true });
	}

	return {
		bundlePath,
		nodeRuntimeRoot,
		authDir,
		piVersion,
		async cleanup() {
			await rm(outputDir, { recursive: true, force: true });
		},
	};
}
