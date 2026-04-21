import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelChoice, QuestEvalName, QuestEvalProvenance, QuestEvalRunMode, QuestState } from "./types.js";
import { runInternalQuestHeadless, type QuestInternalHeadlessRunInput } from "./internal-headless.js";

export interface ParsedArgs {
	command: "help" | "run";
	json?: boolean;
	input?: QuestInternalHeadlessRunInput;
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
	evaluation?: QuestEvalProvenance;
}

function currentProgramName(): string {
	const current = process.argv[1];
	if (!current) return "quest-eval-headless";
	return basename(current).replace(/\.(mjs|cjs|js|ts)$/i, "") || "quest-eval-headless";
}

export function usage(programName = currentProgramName()): string {
	return `Usage:
  ${programName} run --instruction "Solve the task" --eval frontierswe --suite frontierswe-sample@v1 --task-id task-001 [options]
  ${programName} run --instruction-file ./task.txt --eval local --suite local@v1 --task-id suite-id [options]

Options:
  --cwd <path>                     Working directory (default: current directory)
  --model <provider/model>         Model to use (default: zai/glm-5.1)
  --thinking <level>               Thinking level (default: run-mode dependent)
  --timeout-ms <ms>                Execution timeout budget in milliseconds
  --dry-run                        Stop after proposal generation
  --no-auto-accept                 Keep the quest at proposal_ready
  --profile <id>                   Eval profile id
  --eval <local|frontierswe>       Eval family
  --suite <name>                   Eval suite identifier
  --task-id <id>                   Eval task identifier
  --checkpoint-id <id>             Eval checkpoint identifier
  --repo <path>                    FrontierSWE checkout for full-corpus discovery
  --run-mode <local|sample|full|custom>
  --json                           Print machine-readable JSON to stdout`;
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
	let evalName: QuestEvalName | undefined;
	let suite: string | undefined;
	let taskId: string | undefined;
	let checkpointId: string | undefined;
	let repo: string | undefined;
	let runMode: QuestEvalRunMode = "custom";

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
			case "--eval":
				evalName = argv[++index] as QuestEvalName;
				break;
			case "--suite":
				suite = argv[++index];
				break;
			case "--task-id":
				taskId = argv[++index];
				break;
			case "--checkpoint-id":
				checkpointId = argv[++index];
				break;
			case "--repo":
				repo = resolve(argv[++index]);
				break;
			case "--run-mode":
				runMode = argv[++index] as QuestEvalRunMode;
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
	if ((evalName || suite || taskId || checkpointId || repo) && (!evalName || !suite || !taskId)) {
		throw new Error("Eval runs require --eval, --suite, and --task-id together.");
	}

	return {
		command: "run",
		json,
		input: {
			cwd,
			instruction: instruction.trim(),
			modelChoice: parseModelChoice(
				modelSpec,
				thinkingLevel ?? (evalName ? (runMode === "full" ? "medium" : "low") : undefined),
			),
			timeoutMs,
			dryRun,
			autoAccept,
			profileId,
			evaluation: evalName
				? {
						name: evalName,
						dataset: suite!,
						taskId: taskId!,
						checkpointId,
						runMode,
						adapterVersion: repo ? `frontierswe-repo:${repo}` : `${suite}-adapter`,
					}
				: undefined,
		},
	};
}

function printHumanSummary(result: QuestHeadlessCliResult): void {
	console.log(`Quest ${result.questId}`);
	console.log(`Status: ${result.status}`);
	console.log(`Summary: ${result.summary}`);
	console.log(`Profile: ${result.profileId}`);
	console.log(`Result artifact: ${result.artifactPaths.result}`);
	console.log(`Traces: ${result.traceBundleIds.join(", ") || "none"}`);
}

async function main() {
	try {
		const parsed = await parseArgs(process.argv.slice(2));
		if (parsed.command === "help") {
			console.log(usage());
			process.exitCode = 0;
			return;
		}
		const result = await runInternalQuestHeadless(parsed.input!);
		if (parsed.json) {
			console.log(JSON.stringify({ status: "ok", data: result, warnings: result.validatorFindings }, null, 2));
		} else {
			printHumanSummary(result);
		}
		process.exitCode = 0;
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
