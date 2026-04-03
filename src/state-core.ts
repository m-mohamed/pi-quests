import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	LearnedWorkflow,
	ModelChoice,
	QuestConfig,
	QuestEventRecord,
	QuestPlanRevision,
	QuestState,
	QuestStatus,
	QuestStoragePaths,
	ValidationAssertion,
	WorkerRunRecord,
} from "./types.js";

const ACTIVE_FILE = "active.json";
const QUESTS_ROOT_DIR = ".pi/quests";
const QUEST_FILE = "quest.json";
const PROPOSAL_FILE = "proposal.md";
const VALIDATION_READINESS_FILE = "validation-readiness.json";
const VALIDATION_CONTRACT_FILE = "validation-contract.md";
const VALIDATION_STATE_FILE = "validation-state.json";
const FEATURES_FILE = "features.json";
const SERVICES_FILE = "services.yaml";
const EVENTS_FILE = "events.jsonl";
const RUNS_DIR = "runs";
const SKILLS_DIR = "skills";
const SHARED_SKILLS_DIR = "shared-skills";
const SHARED_WORKFLOWS_FILE = "index.json";
const PRUNE_LOG_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const TERMINAL_STATUSES = new Set<QuestStatus>(["completed", "aborted"]);

export function projectIdFor(cwd: string): string {
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
	const name = basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
	return `${name}-${hash}`;
}

function yamlScalar(value: string | number | boolean): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (/^[a-zA-Z0-9._/-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function yamlLines(value: unknown, indent = 0): string[] {
	const prefix = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${prefix}[]`];
		return value.flatMap((item) => {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const entries = Object.entries(item);
				if (entries.length === 0) return [`${prefix}- {}`];
				const [firstKey, firstValue] = entries[0];
				const firstValueLines = yamlLines(firstValue, indent + 2);
				const firstLine = firstValueLines[0]?.trimStart() ?? "";
				const lines = [`${prefix}- ${firstKey}: ${firstLine}`];
				lines.push(...firstValueLines.slice(1));
				for (const [key, nextValue] of entries.slice(1)) {
					const nested = yamlLines(nextValue, indent + 2);
					lines.push(`${" ".repeat(indent + 2)}${key}: ${nested[0]?.trimStart() ?? ""}`);
					lines.push(...nested.slice(1));
				}
				return lines;
			}
			return [`${prefix}- ${yamlScalar(item as string | number | boolean)}`];
		});
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return [`${prefix}{}`];
		return entries.flatMap(([key, nextValue]) => {
			if (Array.isArray(nextValue) || (nextValue && typeof nextValue === "object")) {
				return [`${prefix}${key}:`, ...yamlLines(nextValue, indent + 2)];
			}
			return [`${prefix}${key}: ${yamlScalar(nextValue as string | number | boolean)}`];
		});
	}
	return [`${prefix}${yamlScalar(value as string | number | boolean)}`];
}

function buildConfig(cwd: string, createdAt: number, model: ModelChoice): QuestConfig {
	return {
		orchestratorModel: { ...model },
		workerModel: { ...model },
		validatorModel: { ...model },
		validationConcurrency: 2,
		cwd,
		createdAt,
	};
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "workflow";
}

export function getQuestPaths(cwd: string, questId: string): QuestStoragePaths {
	const rootDir = join(cwd, QUESTS_ROOT_DIR);
	const questDir = join(rootDir, questId);
	const sharedSkillsDir = join(rootDir, SHARED_SKILLS_DIR);
	return {
		rootDir,
		activeFile: join(rootDir, ACTIVE_FILE),
		sharedSkillsDir,
		sharedWorkflowsFile: join(sharedSkillsDir, SHARED_WORKFLOWS_FILE),
		questDir,
		questFile: join(questDir, QUEST_FILE),
		proposalFile: join(questDir, PROPOSAL_FILE),
		validationReadinessFile: join(questDir, VALIDATION_READINESS_FILE),
		validationContractFile: join(questDir, VALIDATION_CONTRACT_FILE),
		validationStateFile: join(questDir, VALIDATION_STATE_FILE),
		featuresFile: join(questDir, FEATURES_FILE),
		servicesFile: join(questDir, SERVICES_FILE),
		skillsDir: join(questDir, SKILLS_DIR),
		eventsFile: join(questDir, EVENTS_FILE),
		runsDir: join(questDir, RUNS_DIR),
	};
}

function summarizeAssertions(assertions: ValidationAssertion[]): string[] {
	if (assertions.length === 0) return ["No validation assertions captured yet."];
	return assertions.map(
		(assertion) =>
			`- [${assertion.status}] ${assertion.id} · ${assertion.criticality} · ${assertion.method}\n  ${assertion.description}${
				assertion.evidence.length ? `\n  Evidence: ${assertion.evidence.join("; ")}` : ""
			}`,
	);
}

function proposalMarkdown(quest: QuestState): string {
	if (quest.proposalMarkdown?.trim()) return quest.proposalMarkdown.trim();
	const plan = quest.plan;
	if (!plan) {
		return `# ${quest.title}\n\n## Goal\n${quest.goal}\n`;
	}
	const milestoneLines =
		plan.milestones.length > 0
			? plan.milestones
					.sort((a, b) => a.order - b.order)
					.map((milestone) => `- ${milestone.title}: ${milestone.description}`)
					.join("\n")
			: "- None yet.";
	const riskLines = plan.risks.length > 0 ? plan.risks.map((risk) => `- ${risk}`).join("\n") : "- None noted.";
	const envLines =
		plan.environment.length > 0 ? plan.environment.map((line) => `- ${line}`).join("\n") : "- Use the existing repo environment.";
	const validationSummary = plan.validationSummary ? `\n## Validation Summary\n${plan.validationSummary}\n` : "";
	return `# ${plan.title}

## Goal
${quest.goal}

## Summary
${plan.summary}

## Milestones
${milestoneLines}

## Risks
${riskLines}

## Environment
${envLines}${validationSummary}`;
}

function validationContractMarkdown(quest: QuestState): string {
	const readiness = quest.validationReadiness;
	const assertions = quest.validationState?.assertions ?? [];
	const readinessLines =
		readiness?.checks.length
			? readiness.checks
					.map(
						(check) =>
							`- ${check.surface} [${check.status}] ${check.description}${
								check.notes ? `\n  Notes: ${check.notes}` : ""
							}${check.commands.length ? `\n  Commands: ${check.commands.join(", ")}` : ""}${
								check.evidence.length ? `\n  Evidence: ${check.evidence.join("; ")}` : ""
							}`,
					)
					.join("\n")
			: "- No readiness checks captured yet.";
	return `# Validation Contract

## Readiness
${readiness?.summary ?? "No validation readiness summary captured yet."}

${readinessLines}

## Assertions
${summarizeAssertions(assertions).join("\n")}
`;
}

function servicesYaml(quest: QuestState): string {
	if (quest.servicesYaml?.trim()) return quest.servicesYaml.trimEnd();
	return yamlLines({
		services: (quest.plan?.services ?? []).map((service) => ({
			name: service.name,
			purpose: service.purpose,
			commands: service.commands,
			ports: service.ports,
			notes: service.notes,
		})),
	}).join("\n");
}

async function ensureRoot(cwd: string): Promise<QuestStoragePaths> {
	const paths = getQuestPaths(cwd, "__bootstrap__");
	await mkdir(paths.rootDir, { recursive: true });
	await mkdir(paths.sharedSkillsDir, { recursive: true });
	return paths;
}

async function ensureQuestDir(cwd: string, questId: string): Promise<QuestStoragePaths> {
	const paths = getQuestPaths(cwd, questId);
	await mkdir(paths.rootDir, { recursive: true });
	await mkdir(paths.sharedSkillsDir, { recursive: true });
	await mkdir(paths.questDir, { recursive: true });
	await mkdir(paths.skillsDir, { recursive: true });
	await mkdir(paths.runsDir, { recursive: true });
	return paths;
}

async function writeSharedWorkflowSkills(paths: QuestStoragePaths, workflows: LearnedWorkflow[]): Promise<void> {
	await mkdir(paths.sharedSkillsDir, { recursive: true });
	const existing = existsSync(paths.sharedSkillsDir) ? await readdir(paths.sharedSkillsDir) : [];
	for (const entry of existing) {
		if (entry === SHARED_WORKFLOWS_FILE) continue;
		if (!entry.endsWith(".md")) continue;
		await unlink(join(paths.sharedSkillsDir, entry)).catch(() => {});
	}
	for (const workflow of workflows) {
		const file = join(paths.sharedSkillsDir, `${slugify(`${workflow.title}-${workflow.id}`)}.md`);
		const body = `# ${workflow.title}

${workflow.note}

Source: ${workflow.source}

Evidence:
${workflow.evidence.length ? workflow.evidence.map((line) => `- ${line}`).join("\n") : "- None recorded."}
`;
		await writeFile(file, `${body.trimEnd()}\n`, "utf-8");
	}
}

async function syncQuestArtifacts(quest: QuestState): Promise<void> {
	const paths = await ensureQuestDir(quest.cwd, quest.id);
	await writeFile(paths.questFile, `${JSON.stringify(quest, null, 2)}\n`, "utf-8");
	await writeFile(paths.proposalFile, `${proposalMarkdown(quest).trimEnd()}\n`, "utf-8");
	await writeFile(paths.validationReadinessFile, `${JSON.stringify(quest.validationReadiness ?? { summary: "", checks: [] }, null, 2)}\n`, "utf-8");
	await writeFile(paths.validationContractFile, `${validationContractMarkdown(quest).trimEnd()}\n`, "utf-8");
	await writeFile(
		paths.validationStateFile,
		`${JSON.stringify(quest.validationState ?? { assertions: [], updatedAt: Date.now() }, null, 2)}\n`,
		"utf-8",
	);
	await writeFile(paths.featuresFile, `${JSON.stringify(quest.plan?.features ?? [], null, 2)}\n`, "utf-8");
	await writeFile(paths.servicesFile, `${servicesYaml(quest)}\n`, "utf-8");
}

function normalizeQuest(quest: QuestState): QuestState {
	if (!quest.config) {
		const baseModel = quest.defaultModel ?? {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high" as const,
		};
		quest.config = buildConfig(quest.cwd, quest.createdAt, baseModel);
	}
	if (!quest.defaultModel) quest.defaultModel = quest.config.orchestratorModel;
	if (!quest.roleModels) {
		quest.roleModels = {
			orchestrator: quest.config.orchestratorModel,
			worker: quest.config.workerModel,
			validator: quest.config.validatorModel,
		};
	}
	if (quest.status === ("ready" as QuestStatus)) quest.status = "proposal_ready";
	if ((quest.status as string) === "failed") quest.status = "blocked";
	quest.plan?.milestones.forEach((milestone, index) => {
		if (milestone.order === undefined) milestone.order = index + 1;
		if (!milestone.description) milestone.description = milestone.summary ?? milestone.title;
		if ((milestone.status as string) === "failed") milestone.status = "blocked";
	});
	quest.plan?.features.forEach((feature, index) => {
		if (feature.order === undefined) feature.order = index + 1;
		if (!feature.description) feature.description = feature.summary ?? feature.title;
		if (!feature.preconditions) feature.preconditions = [];
		if (!feature.fulfills) feature.fulfills = [];
		if ((feature.status as string) === "failed") feature.status = "blocked";
		if (!feature.acceptanceCriteria) feature.acceptanceCriteria = feature.summary ? [feature.summary] : [];
		if (!feature.summary) feature.summary = feature.description;
	});
	if (!quest.plan?.risks) quest.plan && (quest.plan.risks = []);
	if (!quest.plan?.environment) quest.plan && (quest.plan.environment = []);
	if (!quest.plan?.services) quest.plan && (quest.plan.services = []);
	if (!quest.plan?.humanQaChecklist) quest.plan && (quest.plan.humanQaChecklist = []);
	if (!quest.validationState) {
		quest.validationState = {
			assertions: [],
			updatedAt: quest.updatedAt,
		};
	}
	return quest;
}

export async function setActiveQuestId(cwd: string, questId: string | null): Promise<void> {
	const paths = await ensureRoot(cwd);
	if (!questId) {
		if (existsSync(paths.activeFile)) await unlink(paths.activeFile);
		return;
	}
	await writeFile(paths.activeFile, `${JSON.stringify({ questId })}\n`, "utf-8");
}

export async function getActiveQuestId(cwd: string): Promise<string | null> {
	const paths = getQuestPaths(cwd, "__bootstrap__");
	if (!existsSync(paths.activeFile)) return null;
	try {
		const raw = await readFile(paths.activeFile, "utf-8");
		const parsed = JSON.parse(raw) as { questId?: string };
		return parsed.questId ?? null;
	} catch {
		return null;
	}
}

export async function saveQuest(quest: QuestState): Promise<void> {
	quest.updatedAt = Date.now();
	normalizeQuest(quest);
	await syncQuestArtifacts(quest);
}

export async function appendQuestEvent(cwd: string, questId: string, event: QuestEventRecord): Promise<void> {
	const paths = await ensureQuestDir(cwd, questId);
	await writeFile(paths.eventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf-8", flag: "a" });
}

export async function writeWorkerRun(cwd: string, questId: string, record: WorkerRunRecord): Promise<void> {
	const paths = await ensureQuestDir(cwd, questId);
	const file = join(paths.runsDir, `${record.startedAt}-${record.role}-${record.id}.json`);
	await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

export async function loadQuest(cwd: string, questId: string): Promise<QuestState | null> {
	const paths = getQuestPaths(cwd, questId);
	if (!existsSync(paths.questFile)) return null;
	try {
		const raw = await readFile(paths.questFile, "utf-8");
		return normalizeQuest(JSON.parse(raw) as QuestState);
	} catch {
		return null;
	}
}

export async function loadActiveQuest(cwd: string): Promise<QuestState | null> {
	const questId = await getActiveQuestId(cwd);
	if (!questId) return null;
	return loadQuest(cwd, questId);
}

function initialPlanRevision(): QuestPlanRevision[] {
	return [];
}

export async function createQuest(cwd: string, goal: string, defaultModel: ModelChoice): Promise<QuestState> {
	const questId = randomUUID();
	const now = Date.now();
	const quest: QuestState = {
		id: questId,
		projectId: projectIdFor(cwd),
		cwd,
		title: goal,
		goal,
		status: "planning",
		config: buildConfig(cwd, now, defaultModel),
		defaultModel: defaultModel,
		roleModels: {
			orchestrator: { ...defaultModel },
			worker: { ...defaultModel },
			validator: { ...defaultModel },
		},
		validationReadiness: {
			summary: "Validation readiness has not been probed yet.",
			checks: [],
		},
		validationState: {
			assertions: [],
			updatedAt: now,
		},
		planRevisions: initialPlanRevision(),
		pendingPlanRevisionRequests: [],
		steeringNotes: [],
		humanQaStatus: "pending",
		shipReadiness: "not_ready",
		createdAt: now,
		updatedAt: now,
		recentRuns: [],
	};
	await saveQuest(quest);
	await setActiveQuestId(cwd, questId);
	await appendQuestEvent(cwd, questId, { ts: Date.now(), type: "quest_created", data: { goal } });
	return quest;
}

export function questIsTerminal(quest: QuestState): boolean {
	return TERMINAL_STATUSES.has(quest.status);
}

export async function switchActiveQuest(cwd: string, questId: string): Promise<QuestState | null> {
	const quest = await loadQuest(cwd, questId);
	if (!quest) return null;
	await setActiveQuestId(cwd, questId);
	return quest;
}

export async function listProjectQuests(cwd: string): Promise<QuestState[]> {
	const paths = getQuestPaths(cwd, "__bootstrap__");
	if (!existsSync(paths.rootDir)) return [];

	const entries = await readdir(paths.rootDir, { withFileTypes: true });
	const questDirs = entries.filter((entry) => entry.isDirectory() && entry.name !== SHARED_SKILLS_DIR);
	const quests: QuestState[] = [];
	for (const entry of questDirs) {
		const questFile = join(paths.rootDir, entry.name, QUEST_FILE);
		if (!existsSync(questFile)) continue;
		try {
			const raw = await readFile(questFile, "utf-8");
			quests.push(normalizeQuest(JSON.parse(raw) as QuestState));
		} catch {
			continue;
		}
	}
	return quests.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function pruneQuestStorage(cwd: string, now = Date.now()): Promise<{ prunedLogs: number; deletedRuns: number }> {
	const paths = getQuestPaths(cwd, "__bootstrap__");
	if (!existsSync(paths.rootDir)) return { prunedLogs: 0, deletedRuns: 0 };

	let prunedLogs = 0;
	let deletedRuns = 0;
	const entries = await readdir(paths.rootDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === SHARED_SKILLS_DIR) continue;
		const quest = await loadQuest(cwd, entry.name);
		if (!quest || !TERMINAL_STATUSES.has(quest.status) || quest.prunedAt) continue;
		if (now - quest.updatedAt < PRUNE_LOG_AGE_MS) continue;

		const questPaths = getQuestPaths(cwd, quest.id);
		if (existsSync(questPaths.eventsFile)) {
			await unlink(questPaths.eventsFile);
			prunedLogs++;
		}
		if (existsSync(questPaths.runsDir)) {
			const runEntries = await readdir(questPaths.runsDir);
			deletedRuns += runEntries.length;
			await rm(questPaths.runsDir, { recursive: true, force: true });
		}

		quest.prunedAt = now;
		quest.updatedAt = now;
		await saveQuest(quest);
	}

	return { prunedLogs, deletedRuns };
}

export function trimRecentRuns<T extends { startedAt: number }>(runs: T[], max = 12): T[] {
	return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, max);
}

export async function loadLearnedWorkflows(cwd: string): Promise<LearnedWorkflow[]> {
	const paths = getQuestPaths(cwd, "__bootstrap__");
	if (!existsSync(paths.sharedWorkflowsFile)) return [];
	try {
		const raw = await readFile(paths.sharedWorkflowsFile, "utf-8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as LearnedWorkflow[];
	} catch {
		return [];
	}
	return [];
}

export async function saveLearnedWorkflows(cwd: string, workflows: LearnedWorkflow[]): Promise<void> {
	const paths = await ensureRoot(cwd);
	await writeFile(paths.sharedWorkflowsFile, `${JSON.stringify(workflows, null, 2)}\n`, "utf-8");
	await writeSharedWorkflowSkills(paths, workflows);
}

export async function questDirStats(cwd: string, questId: string): Promise<{ hasEvents: boolean; runFiles: number }> {
	const paths = getQuestPaths(cwd, questId);
	if (!existsSync(paths.questFile)) return { hasEvents: false, runFiles: 0 };
	const hasEvents = existsSync(paths.eventsFile);
	let runFiles = 0;
	if (existsSync(paths.runsDir)) runFiles = (await readdir(paths.runsDir)).length;
	return { hasEvents, runFiles };
}

export async function questAgeMs(cwd: string, questId: string): Promise<number | null> {
	const paths = getQuestPaths(cwd, questId);
	if (!existsSync(paths.questFile)) return null;
	const stats = await stat(paths.questFile);
	return Date.now() - stats.mtimeMs;
}
