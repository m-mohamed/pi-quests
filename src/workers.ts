import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import {
	runAgentTask,
	type RunAgentTaskOptions,
	type RunAgentTaskResult,
} from "./agent-task-runner.js";
import { promptSurfaceText, toolAllowlistForRole } from "./profile-core.js";
import { parseQuestPlanText } from "./plan-core.js";
import type {
	QuestEvalProvenance,
	QuestExperimentCandidate,
	LearnedWorkflow,
	LiveRunSnapshot,
	ModelChoice,
	QuestFeature,
	QuestMilestone,
	QuestPlan,
	QuestPlanRevisionRequest,
	QuestProfile,
	QuestState,
	ValidationAssertion,
	ValidationReadiness,
	ValidationSurfaceStatus,
	WorkerRunRecord,
} from "./types.js";

interface FeatureWorkerPayload {
	status?: string;
	summary?: string;
	filesTouched?: string[];
	followUps?: string[];
	finalSubmissionReady?: boolean;
	selfCheck?: string[];
	contradictions?: string[];
	openQuestions?: string[];
	needsHuman?: boolean;
}

interface ValidatorPayload {
	status?: string;
	summary?: string;
	issues?: string[];
}

interface ValidationReadinessPayload {
	summary?: string;
	checks?: Array<{
		id?: string;
		surface?: string;
		description?: string;
		status?: string;
		commands?: string[];
		evidence?: string[];
		notes?: string;
	}>;
	services?: Array<{
		name?: string;
		purpose?: string;
		commands?: string[];
		ports?: number[];
		notes?: string[];
	}>;
}

interface OptimizerProposerContext {
	communityStatsPath: string;
	frontierStatePath: string;
	candidatesDir: string;
	searchSetPath: string;
	holdOutSetPath: string;
	searchTagSummary?: Record<string, number>;
	holdOutTagSummary?: Record<string, number>;
	communityStats?: {
		totalSessions?: number;
		parsedSessions?: number;
		failureTags?: Record<string, number>;
	};
	leaderSummary?: {
		candidateId?: string;
		summary?: string;
		searchScore?: {
			meanScore?: number;
			totalCost?: number;
			totalDurationMs?: number;
		};
		tagBreakdown?: Record<
			string,
			{
				itemCount?: number;
				passed?: number;
				meanScore?: number;
			}
		>;
		failureCategoryBreakdown?: Record<string, number>;
	};
}

type RunPiTaskOptions = RunAgentTaskOptions;
type RunPiTaskResult = RunAgentTaskResult;

type ValidatorPass = "code_review" | "user_surface";

async function parseInternalQuestExperimentCandidate(text: string): Promise<QuestExperimentCandidate | null> {
	const internalProfiles = await import("./internal-profile-core.js");
	return internalProfiles.parseQuestExperimentCandidate(text);
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function extractJsonBlock<T>(text: string): T | null {
	const fenced = text.match(/```json\s*([\s\S]*?)```/i);
	if (!fenced) return null;
	try {
		return JSON.parse(fenced[1]) as T;
	} catch {
		return null;
	}
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => String(entry ?? "").trim())
		.filter(Boolean);
}

function evaluationExecutionIssues(parsed: FeatureWorkerPayload | null): string[] {
	if (!parsed) {
		return ["Worker did not return the required eval JSON block."];
	}

	const issues: string[] = [];
	if (parsed.status !== "completed") {
		issues.push("Worker did not declare the eval task completed.");
	}
	if (parsed.finalSubmissionReady !== true) {
		issues.push("Worker did not confirm a single final submission was ready.");
	}
	if (normalizeStringList(parsed.selfCheck).length === 0) {
		issues.push("Worker did not report a final self-check on the eval outputs.");
	}
	if (parsed.needsHuman === true) {
		issues.push("Worker requested human handoff during eval execution.");
	}
	for (const contradiction of normalizeStringList(parsed.contradictions).slice(0, 3)) {
		issues.push(`Worker reported unresolved contradictory evidence: ${contradiction}`);
	}
	for (const question of normalizeStringList(parsed.openQuestions).slice(0, 3)) {
		issues.push(`Worker reported unresolved open question: ${question}`);
	}
	return [...new Set(issues)];
}

function learnedWorkflowSection(workflows: LearnedWorkflow[]): string {
	if (workflows.length === 0) return "- None";
	return workflows.map((workflow) => `- ${workflow.title}: ${workflow.note}`).join("\n");
}

function validationAssertionsForFeature(quest: QuestState, feature: QuestFeature): ValidationAssertion[] {
	const assertions = quest.validationState?.assertions ?? [];
	if (feature.fulfills.length > 0) {
		return assertions.filter((assertion) => feature.fulfills.includes(assertion.id));
	}
	return assertions.filter((assertion) => assertion.featureIds?.includes(feature.id));
}

function validationAssertionsForMilestone(
	quest: QuestState,
	milestone: QuestMilestone,
	pass?: ValidatorPass,
): ValidationAssertion[] {
	const assertions = (quest.validationState?.assertions ?? []).filter((assertion) => assertion.milestoneId === milestone.id);
	if (!pass) return assertions;
	if (pass === "code_review") {
		return assertions.filter((assertion) => assertion.method !== "user_surface");
	}
	return assertions.filter((assertion) => assertion.method === "user_surface" || assertion.method === "mixed");
}

function questContext(quest: QuestState, workflows: LearnedWorkflow[]): string {
	const notes = quest.steeringNotes.length ? quest.steeringNotes.map((note) => `- ${note}`).join("\n") : "- None";
	const readiness = quest.validationReadiness?.checks.length
		? quest.validationReadiness.checks.map((check) => `- ${check.surface} [${check.status}] ${check.description}`).join("\n")
		: "- No validation readiness checks captured.";

	return `Quest: ${quest.plan?.title ?? quest.title}

Goal:
${quest.goal}

Quest summary:
${quest.plan?.summary ?? quest.lastSummary ?? "No summary yet."}

Steering notes:
${notes}

Validation readiness:
${readiness}

Project learned workflows:
${learnedWorkflowSection(workflows)}`;
}

function loadedSessionContextGuidance(): string {
	return `Loaded session context:
- Pi may already have repo/global AGENTS.md instructions, contextual files, and matching skills in scope.
- Treat those loaded instructions as binding, not optional hints.
- If a relevant skill is already loaded, use it instead of inventing a new workflow from scratch.`;
}

function evaluationWorkspaceHint(evaluation: QuestEvalProvenance): string {
	if (evaluation.name === "frontierswe") {
		return `Task workspace: /app
Task note: FrontierSWE tasks run inside a Docker task image. Treat /app as the writable task workspace, /logs/agent as agent logs, and verifier-owned files under /tests or verifier-only mounts as immutable.`;
	}
	return "Task workspace: use the paths named in the task or suite instructions.";
}

function evaluationTaskHint(evaluation: QuestEvalProvenance): string {
	const taskId = evaluation.taskId;
	if (
		/(image|video|ocr|gcode|elf)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a media or binary-inspection task first, not a general coding task.
- Start with the exact input files using \`file\`, short Python scripts, and task-local metadata inspection before broader exploration.
- Prefer deterministic extraction/transformation tools already on the machine over installing new stacks.
- Write the exact required output path, then re-open it and spot-check bytes, rows, or decoded content before finishing.`;
	}
	if (
		/(^git-|fix-git|sanitize-git-repo|multibranch|leak-recovery)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a Git-state recovery task first.
- Before editing anything, inspect \`git status --short\`, \`git branch -a\`, \`git log --oneline --decorate --all -n 20\`, and \`git reflog -n 20\`.
- Prefer recovering the intended repo state from existing refs, reflog entries, stashes, or objects instead of re-creating content manually.
- Keep the final repo state minimal and verifiable with the exact Git command that proves the task is solved.`;
	}
	if (
		/(build-|compile-|install-|make-|modernization|modernize|compcert|ocaml|windows)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a build or installation task first.
- Read the nearest README, Makefile, configure script, or build config before changing code.
- Prefer the lightest successful path: existing system packages, release tarballs, or documented build targets before custom source surgery.
- Verify the requested binary, artifact, or command actually runs before you finish.`;
	}
	if (
		/(server|nginx|grpc|mailman|pypi|headless-terminal|cert|request-logging)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a local service task first.
- Keep changes tightly scoped to the requested port, protocol, and on-disk config.
- After configuration, verify the service locally with the exact client path the task implies, such as \`curl\`, \`nc\`, or the target CLI.
- Do not leave unrelated daemons or extra listeners running.`;
	}
	if (
		/(model|torch|pytorch|stan|sampling|eigen|mteb|dataset|dna|protein|financial|portfolio|inference|relu|caffe)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a data, ML, or scientific-computing task first.
- Inspect schemas, input formats, and required output contracts before touching code.
- Prefer short deterministic Python or shell pipelines over exploratory notebooks or heavy framework churn.
- Avoid retraining, redownloading, or long installs unless the task explicitly requires it; verify the requested metric or output file directly.`;
	}
	if (
		/(7z|recovery|wal|crack|feal|password)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as an archive, crypto, or recovery task first.
- Start with format and evidence inspection using \`file\`, \`strings\`, archive tools, OpenSSL helpers, or Python stdlib before broader changes.
- Prefer extracting the missing fact or artifact from the existing inputs over building new machinery.
- Record the exact recovered output in the required location and verify it once before finishing.`;
	}
	if (
		/(filter|merge|editing|modify|query|hbox|polyglot|break-)/.test(taskId)
	) {
		return `Task-specific hint:
- Treat this as a precise transformation task first.
- Inspect the exact source files and output requirements before changing anything.
- Prefer a short deterministic script or minimal patch over interactive/manual editing.
- Spot-check a few representative cases, then verify the final output path or diff matches the task contract.`;
	}
	return "";
}

export function buildFeaturePrompt(
	quest: QuestState,
	feature: QuestFeature,
	milestone: QuestMilestone,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	evaluation?: QuestEvalProvenance,
): string {
	if (evaluation) {
		return `Eval task:
- eval: ${evaluation.name}
- suite: ${evaluation.dataset}
- task: ${evaluation.taskId}
- run mode: ${evaluation.runMode}
- checkpoint: ${evaluation.checkpointId ?? "none"}

Repository root: ${quest.cwd}

${evaluationWorkspaceHint(evaluation)}

Task goal:
${quest.goal}

Assigned feature:
${feature.title}
${feature.description}

Execution policy:
- Solve the task with the shortest correct path.
- Ignore .pi/, quest bookkeeping, candidate archives, and unrelated repo cleanup.
- Inspect named task paths before broad exploration.
- When the task is repo-local code work with an existing test harness, add or update the narrowest failing test before broader implementation.
- Produce the exact required artifact, re-open it for one final format check, then stop.
- Keep narration minimal and spend tokens on execution.

Eval heuristics:
- Prefer a short bash or Python script over extended exploration.
- Use Python or CLI tools for images, archives, PDFs, and structured data instead of raw text inspection.
- Keep scratch work under /tmp and leave task directories with only required deliverables.
- For unseen tasks, classify the job quickly: media/binary inspection, Git recovery, build/install, local service, data/science, archive/recovery, or precise text transform.
- Avoid heavyweight installs, package-manager churn, and source builds unless the task explicitly requires them; after one failed or slow setup path, pivot.
- Before you finish, re-open the exact output paths and verify their bytes, rows, or fields match the task contract.
- If your own check fails or new evidence contradicts the current approach, re-plan inside the same turn before the final JSON.
- Your job is implementation only. Do not treat your own confidence as the final judge; the external verifier decides.
- Do not ask for human help, approval, or follow-up on eval tasks; either finish cleanly or return blocked.
- Treat verifier scripts, reward files, PATH-critical tools, package-manager shims, and system binaries as immutable unless the task explicitly requires changes there.

${evaluationTaskHint(evaluation)}

Profile surface policy:
${promptSurfaceText(profile, "feature-worker")}

At the end, output:
## Feature Result
- summary
- files touched
- follow-ups if any

\`\`\`json
{
  "status": "completed",
  "summary": "what you completed",
  "filesTouched": ["optional/path"],
  "followUps": [],
  "finalSubmissionReady": true,
  "selfCheck": ["verified the exact eval outputs and format"],
  "contradictions": [],
  "openQuestions": [],
  "needsHuman": false
}
\`\`\`
`;
	}

	const preconditions = feature.preconditions.length ? feature.preconditions.map((item) => `- ${item}`).join("\n") : "- None.";
	const assertions = validationAssertionsForFeature(quest, feature);
	const validationLines =
		assertions.length > 0
			? assertions
					.map(
						(assertion) =>
							`- ${assertion.id} · ${assertion.method} · ${assertion.criticality}\n  ${assertion.description}${
								assertion.commands?.length ? `\n  Commands: ${assertion.commands.join(", ")}` : ""
							}`,
					)
			.join("\n")
			: "- No feature-specific validation assertions were captured.";
	const contextPolicy =
		profile.contextPolicy.spillLongOutputsToReports
			? `If evidence exceeds roughly ${profile.contextPolicy.spillThresholdChars} characters, summarize it inline and spill the rest to a report instead of bloating the response.`
			: "Keep evidence compact and inline.";

	return `${questContext(quest, workflows)}

Current milestone: ${milestone.title}
Milestone summary: ${milestone.description}

Assigned feature: ${feature.title}
Feature summary: ${feature.description}

Preconditions:
${preconditions}

Validation assertions satisfied by this feature:
${validationLines}

Profile surface policy:
${promptSurfaceText(profile, "feature-worker")}

Context policy:
${contextPolicy}

${loadedSessionContextGuidance()}

${feature.handoff ? `Expected handoff:\n${feature.handoff}\n` : ""}${feature.workerPrompt ? `Feature-specific instructions:\n${feature.workerPrompt}\n` : ""}

Execute only this feature. Keep the quest serial and scoped. Do not introduce unrelated changes.
Start from the narrowest missing proof for this feature. When the repo has a matching test harness or check command, prefer adding or updating the smallest failing test first.
Your job is to implement and hand off this feature. The validator, not you, decides final correctness.

At the end, output:
## Feature Result
- summary
- files touched
- follow-ups if any

\`\`\`json
{
  "status": "completed",
  "summary": "what you completed",
  "filesTouched": ["optional/path"],
  "followUps": ["optional follow-up"]
}
\`\`\`
`;
}

export function buildWorkerSystemPrompt(profile: QuestProfile, evaluationMode = false): string {
	return `You are a quest worker executing a single feature within a larger Pi quest.

Rules:
- Focus only on the assigned feature.
- Respect loaded AGENTS.md instructions and reuse relevant loaded skills when they apply.
- Treat the quest as a strict separation-of-concerns loop: implement the assigned feature, then hand it off.
- Make the smallest correct change that satisfies the feature.
- Do not start new quests or inspect quest internals.
- Do not rewrite unrelated parts of the codebase.
- When the repo already has a test harness or validation command for the feature, prefer adding or updating the narrowest failing test before broader implementation.
- ${evaluationMode ? "In eval mode, treat the external verifier as a score sensor, not a mutable target." : "Use the repo's native validation signals when they are available."}
- ${evaluationMode ? "Never modify verifier scripts, reward files, PATH-critical tools, package-manager shims, or system binaries unless the task explicitly requires it." : "Keep validation surfaces and developer tooling stable unless the task explicitly targets them."}
- ${evaluationMode ? "When the task names a path, inspect or write that exact path first." : "Inspect the smallest relevant scope before making changes."}
- ${evaluationMode ? "Use short bash or Python scripts for binary, image, and structured-data tasks." : "Prefer the lightest tool that can answer the question."}
- ${evaluationMode ? "Remove transient scratch artifacts from task-owned outputs before finishing." : "Clean up transient local artifacts when they are no longer needed."}
- ${evaluationMode ? "Do not request human help or leave provisional output during eval execution." : "Raise explicit blockers instead of hand-waving unresolved work."}
- ${evaluationMode ? "Do not treat your own confidence as the final pass signal; the verifier decides." : "Do not self-approve the feature; the validator decides whether it is done."}
- ${evaluationMode ? "Before the final JSON, re-open the exact outputs and confirm a single final submission is ready." : "Before finishing, summarize what still needs human QA."}
- ${evaluationMode ? "If evidence contradicts the current path, re-plan inside the same turn instead of shipping a provisional answer." : "Prefer the smallest correction path when evidence changes."}
- ${evaluationMode ? "After one failed or slow setup path, pivot instead of doubling down on installs or source builds." : "Prefer low-friction setup paths before heavyweight environment changes."}
- Budget: at most ${profile.verificationBudget.workerAttempts} worker attempt(s) before handing control back.
- End with the required JSON block.`;
}

export function buildValidatorPrompt(
	quest: QuestState,
	milestone: QuestMilestone,
	features: QuestFeature[],
	workflows: LearnedWorkflow[],
	pass: ValidatorPass,
	profile: QuestProfile,
): string {
	const featureList = features.map((feature) => `- ${feature.title}: ${feature.lastRunSummary ?? feature.description}`).join("\n");
	const assertions = validationAssertionsForMilestone(quest, milestone, pass);
	const validationLines =
		assertions.length > 0
			? assertions
					.map(
						(assertion) =>
							`- ${assertion.id} · ${assertion.method} · ${assertion.criticality}\n  ${assertion.description}${
								assertion.commands?.length ? `\n  Commands: ${assertion.commands.join(", ")}` : ""
							}`,
					)
					.join("\n")
			: "- No matching assertions were captured for this validation pass.";
	const passDescription =
		pass === "code_review"
			? "Perform a code/procedure review. Prefer repo commands, typechecks, tests, and read-only inspection."
			: "Perform a user-surface validation pass. Prefer browser-visible flows, CLI-visible behavior, and operator-facing outcomes.";
	const surfaceId = pass === "code_review" ? "validator-code-review" : "validator-user-surface";

	return `${questContext(quest, workflows)}

Validate the milestone "${milestone.title}".

Completed features in this milestone:
${featureList}

Validation pass:
${passDescription}

Assertions for this pass:
${validationLines}

Profile surface policy:
${promptSurfaceText(profile, surfaceId)}

${loadedSessionContextGuidance()}

${milestone.validationPrompt ? `Extra validation guidance:\n${milestone.validationPrompt}\n` : ""}

You are read-only. Verify the milestone. Do not edit code.
Surface issues only. Phrase them so the orchestrator can create targeted fix features instead of broad rewrites.

At the end, output:
\`\`\`json
{
  "status": "pass",
  "summary": "validation result",
  "issues": []
}
\`\`\`
`;
}

export function buildValidatorSystemPrompt(pass: ValidatorPass, profile: QuestProfile): string {
	return `You are a read-only quest validator running the ${pass} pass.

Rules:
- Verify the assigned milestone using read-only tools and commands.
- Respect loaded AGENTS.md instructions and any relevant loaded skills while staying read-only.
- Do not edit or write files.
- Do not propose code patches or implement fixes. Surface issues the orchestrator can convert into targeted fix features.
- Be explicit about issues, blockers, or limited coverage.
- Budget: at most ${profile.verificationBudget.validatorAttempts} validator attempt(s) before handing control back.
- End with the required JSON block.`;
}

export function buildPlanRevisionSystemPrompt(profile: QuestProfile): string {
	return `You are the quest orchestrator revising only the remaining plan for an existing Pi quest.

Rules:
- Preserve completed work.
- Only change unfinished milestones, unfinished features, and validation for unfinished work.
- Turn validator findings into the smallest corrective features that close the affected assertions.
- Keep the quest serial by default.
- Respect loaded AGENTS.md instructions and reuse relevant loaded skills when they apply.
- Do not edit repository files.
- Policy surface:
${promptSurfaceText(profile, "plan-revision")}
- End with the required JSON block.`;
}

function buildReadinessProbePrompt(cwd: string, profile: QuestProfile): string {
	return `Probe validation readiness for this repository at ${cwd}.

You are a dry-run validator. Do not edit files.

Inspect the repository and determine which validation surfaces are available.
Consider at least:
- repo checks (test, lint, typecheck, build)
- browser or user-surface validation
- dev server startup
- local services or docker dependencies
- API or command-line validation

Profile surface policy:
${promptSurfaceText(profile, "readiness-probe")}

${loadedSessionContextGuidance()}

Return:
\`\`\`json
{
  "summary": "short summary",
  "checks": [
    {
      "id": "checks",
      "surface": "repo-checks",
      "description": "what can be validated",
      "status": "supported",
      "commands": ["npm test"],
      "evidence": ["package.json script found"],
      "notes": "optional caveat"
    }
  ],
  "services": [
    {
      "name": "web",
      "purpose": "dev server",
      "commands": ["npm run dev"],
      "ports": [3000],
      "notes": ["optional caveat"]
    }
  ]
}
\`\`\``;
}

function buildPlanningPrompt(
	cwd: string,
	goal: string,
	readiness: ValidationReadiness | null,
	profile: QuestProfile,
	evaluation?: QuestEvalProvenance,
): string {
	const readinessLines =
		readiness?.checks.length
			? readiness.checks.map((check) => `- ${check.surface} [${check.status}] ${check.description}`).join("\n")
			: "- No readiness checks captured.";
	const evaluationLines = evaluation
		? `Eval context:
- eval: ${evaluation.name}
- suite: ${evaluation.dataset}
- task: ${evaluation.taskId}
- checkpoint: ${evaluation.checkpointId ?? "none"}
- run mode: ${evaluation.runMode}`
		: "Eval context:\n- none";
	return `Plan a headless Quest for this repository at ${cwd}.

Goal:
${goal}

${evaluationLines}

Validation readiness:
${readiness?.summary ?? "No readiness summary captured yet."}

${readinessLines}

Profile surface policy:
${promptSurfaceText(profile, "planning")}

${loadedSessionContextGuidance()}

Return a compact quest plan as JSON with:
- title
- summary
- risks
- environment
- services
- validationSummary
- humanQaChecklist
- milestones
- features

Requirements:
- Keep execution serial by default.
- Prefer 1-4 features.
- Treat every "fulfills" entry as part of the validation contract and define that contract before finalizing features.
- Every feature must have explicit fulfills entries.
- Keep the final human QA handoff explicit.
- Be honest about limited or unsupported validation.

\`\`\`json
{
  "title": "Quest title",
  "summary": "Short plan summary",
  "risks": ["optional risk"],
  "environment": ["optional note"],
  "services": [],
  "validationSummary": "what is automated vs limited",
  "humanQaChecklist": ["manual QA item"],
  "milestones": [
    {
      "id": "m1",
      "order": 1,
      "title": "Complete eval task",
      "description": "Finish the assigned eval task",
      "successCriteria": ["task passes validation"],
      "status": "pending"
    }
  ],
  "features": [
    {
      "id": "f1",
      "order": 1,
      "milestoneId": "m1",
      "title": "Implement the eval task",
      "description": "Finish the required repo work",
      "preconditions": [],
      "fulfills": ["required validation outcome"],
      "status": "pending",
      "handoff": "brief handoff"
    }
  ]
}
\`\`\``;
}

export function buildPlannerSystemPrompt(profile: QuestProfile): string {
	return `You are the quest orchestrator planning a headless Pi quest.

Rules:
- Plan the smallest serial execution path that can solve the task.
- Define the validation contract before the feature list and keep the contract independent from implementation bias.
- Keep human QA explicit at the end.
- Be honest about limited or unsupported validation.
- Respect loaded AGENTS.md instructions and use relevant loaded skills when they already fit the job.
- Do not emit prose outside the required JSON block.
- Planning policy:
${promptSurfaceText(profile, "planning")}`;
}

async function runPiTask(options: RunPiTaskOptions): Promise<RunPiTaskResult> {
	return runAgentTask(options);
}

function workerRunFromResult(
	modelChoice: ModelChoice,
	result: RunPiTaskResult,
	role: WorkerRunRecord["role"],
	startedAt: number,
	extra: Partial<WorkerRunRecord>,
	summary: string,
	ok: boolean,
	issues?: string[],
	evaluation?: QuestEvalProvenance,
): WorkerRunRecord {
	return {
		id: randomUUID(),
		sessionId: result.sessionId,
		sessionFile: result.sessionFile,
		role,
		startedAt,
		endedAt: Date.now(),
		provider: modelChoice.provider,
		model: modelChoice.model,
		thinkingLevel: modelChoice.thinkingLevel,
		exitCode: result.exitCode,
		ok,
		summary,
		stopReason: result.stopReason,
		stderr: result.stderr || undefined,
		issues,
		aborted: result.aborted,
		signal: result.signal,
		phase: result.phase,
		latestToolName: result.latestToolName,
		latestToolSummary: result.latestToolSummary,
		latestAssistantText: result.latestAssistantText,
		events: result.events,
		usage: result.usage,
		evaluation: evaluation ? { ...evaluation } : undefined,
		...extra,
	};
}

export async function executeValidationReadinessProbe(
	cwd: string,
	modelChoice: ModelChoice,
	profile: QuestProfile,
	evaluation: QuestEvalProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; readiness: ValidationReadiness | null; servicesYaml: string | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: [...toolAllowlistForRole(profile, "validator"), "find", "grep"],
		role: "validator",
		systemPrompt: buildValidatorSystemPrompt("code_review", profile),
		prompt: buildReadinessProbePrompt(cwd, profile),
		evaluation,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<ValidationReadinessPayload>(text);
	const readiness: ValidationReadiness | null =
		parsed && Array.isArray(parsed.checks)
			? {
					summary: parsed.summary || "Dry-run validation readiness captured.",
					checks: parsed.checks.map((check, index) => ({
						id: check.id || `readiness-${index + 1}`,
						surface: check.surface || "unknown",
						description: check.description || "No description provided.",
						status: (check.status === "supported" || check.status === "limited" || check.status === "unsupported"
							? check.status
							: "limited") as ValidationSurfaceStatus,
						commands: Array.isArray(check.commands) ? check.commands.map(String) : [],
						evidence: Array.isArray(check.evidence) ? check.evidence.map(String) : [],
						notes: check.notes ? String(check.notes) : undefined,
					})),
				}
			: null;
	const servicesYaml =
		parsed?.services && Array.isArray(parsed.services)
			? `services:\n${parsed.services
					.map((service) => {
						const ports = Array.isArray(service.ports) && service.ports.length > 0 ? `\n    ports: [${service.ports.join(", ")}]` : "";
						const notes =
							Array.isArray(service.notes) && service.notes.length > 0 ? `\n    notes:\n${service.notes.map((note) => `      - ${note}`).join("\n")}` : "";
						return `  - name: ${service.name || "service"}\n    purpose: ${service.purpose || ""}\n    commands:\n${
							Array.isArray(service.commands) && service.commands.length > 0
								? service.commands.map((command) => `      - ${command}`).join("\n")
								: "      -"
						}${ports}${notes}`;
					})
					.join("\n")}`
			: null;

	const ok = result.exitCode === 0 && Boolean(readiness);
	return {
		readiness,
		servicesYaml,
		run: workerRunFromResult(
			modelChoice,
			result,
			"validator",
			startedAt,
				{},
				readiness?.summary || text || "No readiness summary returned.",
				ok,
				undefined,
				evaluation,
			),
		};
}

export async function executeQuestPlanner(
	cwd: string,
	goal: string,
	modelChoice: ModelChoice,
	readiness: ValidationReadiness | null,
	profile: QuestProfile,
	evaluation: QuestEvalProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; plan: QuestPlan | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "orchestrator"),
		role: "orchestrator",
		systemPrompt: buildPlannerSystemPrompt(profile),
		prompt: buildPlanningPrompt(cwd, goal, readiness, profile, evaluation),
		evaluation,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const plan = parseQuestPlanText(text)?.plan ?? null;

	return {
		plan,
		run: workerRunFromResult(
			modelChoice,
			result,
			"orchestrator",
			startedAt,
			{},
			plan ? `Planned ${plan.features.length} feature(s) for ${plan.title}.` : text || "No quest plan returned.",
			result.exitCode === 0 && Boolean(plan),
			undefined,
			evaluation,
		),
	};
}

export async function executeFeatureWorker(
	quest: QuestState,
	feature: QuestFeature,
	milestone: QuestMilestone,
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	evaluation: QuestEvalProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "worker"),
		role: "worker",
		featureId: feature.id,
		milestoneId: milestone.id,
		systemPrompt: buildWorkerSystemPrompt(profile, Boolean(evaluation)),
		prompt: buildFeaturePrompt(quest, feature, milestone, workflows, profile, evaluation),
		evaluation,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<FeatureWorkerPayload>(text);
	const evaluationIssues = evaluation ? evaluationExecutionIssues(parsed) : [];
	const ok =
		result.exitCode === 0 &&
		parsed?.status !== "failed" &&
		parsed?.status !== "blocked" &&
		evaluationIssues.length === 0;

	return workerRunFromResult(
		modelChoice,
		result,
		"worker",
		startedAt,
		{ featureId: feature.id, milestoneId: milestone.id },
		parsed?.summary || text || "No worker summary returned.",
		ok,
		evaluationIssues.length > 0 ? evaluationIssues : undefined,
		evaluation,
	);
}

export async function executeValidator(
	quest: QuestState,
	milestone: QuestMilestone,
	features: QuestFeature[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	pass: ValidatorPass,
	profile: QuestProfile,
	evaluation: QuestEvalProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<WorkerRunRecord> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "validator"),
		role: "validator",
		milestoneId: milestone.id,
		systemPrompt: buildValidatorSystemPrompt(pass, profile),
		prompt: buildValidatorPrompt(quest, milestone, features, workflows, pass, profile),
		evaluation,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const parsed = extractJsonBlock<ValidatorPayload>(text);
	const issues = parsed?.issues ?? [];
	const ok = result.exitCode === 0 && parsed?.status !== "fail" && parsed?.status !== "blocked";

	return workerRunFromResult(
		modelChoice,
		result,
		"validator",
		startedAt,
		{ milestoneId: milestone.id },
		parsed?.summary || text || `No ${pass} summary returned.`,
		ok,
		issues,
		evaluation,
	);
}

export async function executePlanRevision(
	quest: QuestState,
	requests: QuestPlanRevisionRequest[],
	modelChoice: ModelChoice,
	workflows: LearnedWorkflow[],
	profile: QuestProfile,
	evaluation: QuestEvalProvenance | undefined,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; revisedPlan: QuestPlan | null }> {
	const startedAt = Date.now();
	const result = await runPiTask({
		cwd: quest.cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "orchestrator"),
		role: "orchestrator",
		systemPrompt: buildPlanRevisionSystemPrompt(profile),
		prompt: `Revise the remaining quest plan.\n\nRequests:\n${requests.map((request) => `- [${request.source}] ${request.note}`).join("\n")}\n\nCurrent plan:\n\`\`\`json\n${JSON.stringify(quest.plan, null, 2)}\n\`\`\`\n\nCurrent validation state:\n\`\`\`json\n${JSON.stringify(quest.validationState, null, 2)}\n\`\`\`\n\nLearned workflows:\n${learnedWorkflowSection(workflows)}`,
		evaluation,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const revisedPlan = parseQuestPlanText(text)?.plan ?? null;
	const ok = result.exitCode === 0 && Boolean(revisedPlan);

	return {
		revisedPlan,
		run: workerRunFromResult(
			modelChoice,
			result,
			"orchestrator",
			startedAt,
			{},
			revisedPlan ? "Revised remaining quest plan." : text || "No plan revision returned.",
			ok,
			undefined,
			evaluation,
		),
	};
}

export async function executeOptimizerProposerAgent(
	cwd: string,
	modelChoice: ModelChoice,
	profile: QuestProfile,
	target: QuestProfile["target"],
	context: OptimizerProposerContext,
	onSnapshot?: (snapshot: LiveRunSnapshot) => void | Promise<void>,
	onProcessStart?: (pid: number) => void | Promise<void>,
): Promise<{ run: WorkerRunRecord; candidate: QuestExperimentCandidate | null }> {
	const startedAt = Date.now();
	const topFailureTags = Object.entries(context.communityStats?.failureTags ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
		.slice(0, 6)
		.map(([tag, count]) => `${tag}: ${count}`);
	const topSearchTags = Object.entries(context.searchTagSummary ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, count]) => `${tag}: ${count}`);
	const topHoldOutTags = Object.entries(context.holdOutTagSummary ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, count]) => `${tag}: ${count}`);
	const topLeaderFailureCategories = Object.entries(context.leaderSummary?.failureCategoryBreakdown ?? {})
		.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([category, count]) => `${category}: ${count}`);
	const leaderTagBreakdown = Object.entries(context.leaderSummary?.tagBreakdown ?? {})
		.sort((left, right) => ((left[1].meanScore ?? 0) - (right[1].meanScore ?? 0)) || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([tag, metrics]) => `${tag}: mean=${metrics.meanScore ?? 0} passed=${metrics.passed ?? 0}/${metrics.itemCount ?? 0}`);
	const result = await runPiTask({
		cwd,
		modelChoice,
		tools: toolAllowlistForRole(profile, "proposer"),
		role: "proposer",
		systemPrompt: `You are the Quest frontier proposer.

Rules:
- Propose QuestProfilePatch changes only.
- Optimize for eval generalization, not one-off wins.
- Propose one coherent harness/profile change per candidate unless two surface edits are inseparable.
- Respect the proposer policy exactly:
${promptSurfaceText(profile, "proposer")}
- Use the canonical eval optimizer filesystem paths provided in the prompt.
- End with a JSON object only.`,
		prompt: `Target: ${target}

Canonical eval optimizer paths:
- frontier state: ${context.frontierStatePath}
- candidates dir: ${context.candidatesDir}
- community stats: ${context.communityStatsPath}
- search split: ${context.searchSetPath}
- hold-out split: ${context.holdOutSetPath}

Current profile:
\`\`\`json
${JSON.stringify(profile, null, 2)}
\`\`\`

Current frontier leader:
- candidate: ${context.leaderSummary?.candidateId ?? "none"}
- summary: ${context.leaderSummary?.summary ?? "none"}
- mean score: ${context.leaderSummary?.searchScore?.meanScore ?? 0}
- total cost: ${context.leaderSummary?.searchScore?.totalCost ?? 0}
- total duration ms: ${context.leaderSummary?.searchScore?.totalDurationMs ?? 0}
- weakest leader eval tags:
${leaderTagBreakdown.length > 0 ? leaderTagBreakdown.map((line) => `  - ${line}`).join("\n") : "  - none"}
- leader failure categories:
${topLeaderFailureCategories.length > 0 ? topLeaderFailureCategories.map((line) => `  - ${line}`).join("\n") : "  - none"}

Eval split coverage:
- search tags:
${topSearchTags.length > 0 ? topSearchTags.map((line) => `  - ${line}`).join("\n") : "  - none"}
- hold-out tags:
${topHoldOutTags.length > 0 ? topHoldOutTags.map((line) => `  - ${line}`).join("\n") : "  - none"}

Community corpus summary:
- parsed sessions: ${context.communityStats?.parsedSessions ?? 0}/${context.communityStats?.totalSessions ?? 0}
- top failure tags:
${topFailureTags.length > 0 ? topFailureTags.map((line) => `  - ${line}`).join("\n") : "  - none"}

Optimization discipline:
- Treat the search split and community traces as the training data for harness engineering.
- Treat the hold-out split as the unseen generalization check and regression gate.
- Prefer reusable instructions that fix a behavior class, not a task-specific trick.
- Protect already-passing tagged cohorts; if a regression appears likely, account for it explicitly in rationale and targeted tags.
- Use failure-category mixes from eval scorecards to target concrete break modes, not just average score deltas.
- Use candidate traces and summaries to infer recurring failure patterns before patching the profile.

Read the canonical files as needed before you decide.

Return:
\`\`\`json
{
  "summary": "short description",
  "rationale": "why this improves the frontier objective",
  "generalizationNote": "why this should generalize beyond one task or trace",
  "targetedTags": ["weak_validation"],
  "targetedCaseIds": [],
  "promptSurfaceIds": ["proposer"],
  "patch": {
    "promptSurfaces": {
      "workerPolicy": "..."
    }
  }
}
\`\`\``,
		onSnapshot,
		onProcessStart,
	});
	const text = getFinalAssistantText(result.messages);
	const candidate = await parseInternalQuestExperimentCandidate(text);
	return {
		run: workerRunFromResult(
			modelChoice,
			result,
			"proposer",
			startedAt,
			{},
			candidate?.summary ?? (text || "No proposer candidate returned."),
			result.exitCode === 0 && Boolean(candidate),
			undefined,
			undefined,
		),
		candidate,
	};
}
