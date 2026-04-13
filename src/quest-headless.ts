#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInternalMode, internalModeEnabled } from "./internal-mode.js";
import { runQuestHeadless, type QuestHeadlessRunInput } from "./headless-core.js";
import type { ModelChoice, QuestBenchmarkName, QuestBenchmarkProvenance, QuestBenchmarkRunMode, QuestState } from "./types.js";

export interface ParsedArgs {
	command: "help" | "run";
	json?: boolean;
	input?: QuestHeadlessRunInput;
	internalInput?: {
		profileId?: string;
		benchmark?: Omit<QuestBenchmarkProvenance, "recordedAt" | "model">;
	};
}

interface QuestHeadlessCliResult {
	status: QuestState["status"] | "timeout";
	summary: string;
	questId: string;
	profileId: string;
	traceBundleIds: string[];
	validatorFindings: string[];
	executionFindings: string[];
	timeoutReason?: string;
	failureCategory?: string;
	artifactPaths: Record<string, string>;
	benchmark?: QuestBenchmarkProvenance;
}

function currentProgramName(): string {
	const current = process.argv[1];
	if (!current) return "quest-headless";
	return basename(current).replace(/\.(mjs|cjs|js|ts)$/i, "") || "quest-headless";
}

export function usage(programName = currentProgramName()): string {
	const internal = internalModeEnabled();
	return `Usage:
  ${programName} run --instruction "Fix the failing task" [options]
  ${programName} run --instruction-file ./task.txt [options]

What it does:
  Run a headless Quest and write result artifacts under .pi/quests/<quest-id>/.

Options:
  --cwd <path>                     Working directory (default: current directory)
  --model <provider/model>         Model to use (default: zai/glm-5.1)
  --thinking <level>               Thinking level (default: high)
  --timeout-ms <ms>                Execution timeout budget in milliseconds
  --dry-run                        Stop after proposal generation
  --no-auto-accept                 Keep the quest at proposal_ready
  --json                           Print machine-readable JSON to stdout
${internal ? `  --profile <id>                   Internal profile id
  --benchmark <local|terminal-bench|slopcodebench>
  --dataset <name>                 Internal benchmark dataset identifier
  --task-id <id>                   Internal benchmark task identifier
  --checkpoint-id <id>             Internal benchmark checkpoint identifier
  --run-mode <local|sample|full|smoke|custom>` : ""}

Examples:
  ${programName} run --instruction-file ./task.txt --json
  ${programName} run --instruction "Implement the repo task" --cwd "$(pwd)"
${internal ? `  ${programName} run --instruction "Solve the task" --benchmark terminal-bench --dataset terminal-bench-sample@2.0 --task-id task-001 --run-mode smoke` : ""}

Notes:
  Human mode prints a compact summary, the key artifact path, and the next command.
  JSON mode preserves the machine-readable contract.`;
}

export function parseModelChoice(modelSpec: string | undefined, thinkingLevel: string | undefined): ModelChoice {
	const spec = modelSpec ?? "zai/glm-5.1";
	const splitAt = spec.indexOf("/");
	if (splitAt <= 0 || splitAt === spec.length - 1) throw new Error(`Invalid model spec: ${spec}`);
	return {
		provider: spec.slice(0, splitAt),
		model: spec.slice(splitAt + 1),
		thinkingLevel: (thinkingLevel ?? "high") as ModelChoice["thinkingLevel"],
	};
}

export async function parseArgs(argv: string[]): Promise<ParsedArgs> {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		return { command: "help" };
	}
	if (argv[0] !== "run") throw new Error(`Unknown command: ${argv[0]}\n\n${usage()}`);

	let instruction: string | undefined;
	let instructionFile: string | undefined;
	let cwd = resolve(process.env.PWD ?? ".");
	let modelSpec: string | undefined;
	let thinkingLevel: string | undefined;
	let profileId: string | undefined;
	let timeoutMs: number | undefined;
	let dryRun = false;
	let autoAccept = true;
	let json = false;
	let benchmarkName: QuestBenchmarkName | undefined;
	let dataset: string | undefined;
	let taskId: string | undefined;
	let checkpointId: string | undefined;
	let runMode: QuestBenchmarkRunMode = "custom";

	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--instruction":
				instruction = argv[++index];
				break;
			case "--instruction-file":
				instructionFile = argv[++index];
				break;
			case "--cwd":
				cwd = resolve(argv[++index]);
				break;
			case "--model":
				modelSpec = argv[++index];
				break;
			case "--thinking":
				thinkingLevel = argv[++index];
				break;
			case "--profile":
				profileId = argv[++index];
				break;
			case "--timeout-ms":
				timeoutMs = Number(argv[++index]);
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--no-auto-accept":
				autoAccept = false;
				break;
			case "--benchmark":
				benchmarkName = argv[++index] as QuestBenchmarkName;
				break;
			case "--dataset":
				dataset = argv[++index];
				break;
			case "--task-id":
				taskId = argv[++index];
				break;
			case "--checkpoint-id":
				checkpointId = argv[++index];
				break;
			case "--run-mode":
				runMode = argv[++index] as QuestBenchmarkRunMode;
				break;
			case "--json":
				json = true;
				break;
			case "--help":
			case "-h":
				return { command: "help" };
			default:
				throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!instruction && instructionFile) instruction = await readFile(resolve(instructionFile), "utf-8");
	if (!instruction?.trim()) throw new Error(`Missing instruction.\n\n${usage()}`);
	if ((profileId || benchmarkName || dataset || taskId || checkpointId) && !internalModeEnabled()) {
		assertInternalMode("Quest benchmark and profile surfaces");
	}
	if ((benchmarkName || dataset || taskId || checkpointId) && (!benchmarkName || !dataset || !taskId)) {
		throw new Error("Benchmark runs require --benchmark, --dataset, and --task-id together.");
	}

	return {
		command: "run",
		json,
		input: {
			cwd,
			instruction: instruction.trim(),
			modelChoice: parseModelChoice(
				modelSpec,
				thinkingLevel ?? (benchmarkName ? (runMode === "full" ? "medium" : "low") : undefined),
			),
			timeoutMs,
			dryRun,
			autoAccept,
		},
		internalInput:
			profileId || benchmarkName
				? {
						profileId,
						benchmark: benchmarkName
							? {
									benchmark: benchmarkName,
									dataset: dataset!,
									taskId: taskId!,
									checkpointId,
									runMode,
									adapterVersion: "quest-bench-v1",
								}
							: undefined,
					}
				: undefined,
	};
}

function humanNextSteps(result: QuestHeadlessCliResult): string[] {
	if (result.status === "blocked" || result.status === "timeout") {
		const steps = [`bat ${result.artifactPaths.result}`];
		if (result.artifactPaths.validationState) steps.push(`bat ${result.artifactPaths.validationState}`);
		return steps;
	}
	if (result.status === "completed" && result.benchmark) {
		return [`bat ${result.artifactPaths.result}`];
	}
	return [];
}

function printHumanSummary(result: QuestHeadlessCliResult): void {
	console.log(`Quest ${result.questId}`);
	console.log(`Status: ${result.status}`);
	console.log(`Summary: ${result.summary}`);
	if (internalModeEnabled()) console.log(`Profile: ${result.profileId}`);
	console.log(`Result artifact: ${result.artifactPaths.result}`);
	if (result.status === "blocked" || result.status === "timeout") {
		console.log(`Failure: ${result.timeoutReason ?? result.executionFindings[0] ?? result.validatorFindings[0] ?? result.summary}`);
		if (result.failureCategory) console.log(`Failure category: ${result.failureCategory}`);
	}
	console.log(`Traces: ${result.traceBundleIds.join(", ") || "none"}`);
	if (result.executionFindings.length > 0) {
		console.log("Execution findings:");
		for (const finding of result.executionFindings) console.log(`- ${finding}`);
	}
	if (result.validatorFindings.length > 0) {
		console.log("Validator findings:");
		for (const finding of result.validatorFindings) console.log(`- ${finding}`);
	}
	const nextSteps = humanNextSteps(result);
	if (nextSteps.length > 0) {
		console.log("Next:");
		for (const step of nextSteps) console.log(`- ${step}`);
	}
}

async function runCliQuest(parsed: ParsedArgs): Promise<QuestHeadlessCliResult> {
	if (!parsed.input) throw new Error("Missing quest input.");
	if (!parsed.internalInput) {
		return runQuestHeadless(parsed.input);
	}
	try {
		const { runInternalQuestHeadless } = await import("./internal-headless.js");
		return runInternalQuestHeadless({ ...parsed.input, ...parsed.internalInput });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Internal Quest headless surfaces require the repo checkout. ${message}`);
	}
}

async function main() {
	try {
		const parsed = await parseArgs(process.argv.slice(2));
		if (parsed.command === "help") {
			console.log(usage());
			process.exitCode = 0;
			return;
		}
		const result = await runCliQuest(parsed);
		if (parsed.json) {
			console.log(JSON.stringify({ status: "ok", data: result, warnings: result.validatorFindings }, null, 2));
		} else {
			printHumanSummary(result);
		}
		process.exitCode = parsed.internalInput?.benchmark ? 0 : result.status === "blocked" || result.status === "timeout" ? 1 : 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = message.startsWith("Missing instruction") || message.startsWith("Unknown") || message.startsWith("Usage:") ? 2 : 1;
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
