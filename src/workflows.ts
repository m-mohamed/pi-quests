import { randomUUID } from "node:crypto";
import type { LearnedWorkflow, WorkerRunRecord } from "./types.js";

function compact(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function uniqueByTitle(items: LearnedWorkflow[]): LearnedWorkflow[] {
	const byTitle = new Map<string, LearnedWorkflow>();
	for (const item of items) {
		const key = item.title.toLowerCase();
		const existing = byTitle.get(key);
		if (!existing) {
			byTitle.set(key, item);
			continue;
		}
		byTitle.set(key, {
			...existing,
			updatedAt: Math.max(existing.updatedAt, item.updatedAt),
			evidence: [...new Set([...existing.evidence, ...item.evidence])],
			note: existing.note.length >= item.note.length ? existing.note : item.note,
		});
	}
	return [...byTitle.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function collectEvidence(run: WorkerRunRecord): string {
	const parts = [
		run.summary,
		run.stderr,
		run.issues?.join(" "),
		run.events
			.map((event) => [event.toolName, event.summary].filter(Boolean).join(": "))
			.filter(Boolean)
			.join(" "),
	]
		.filter(Boolean)
		.map((part) => compact(String(part)));
	return parts.join(" ");
}

function buildWorkflow(title: string, note: string, source: LearnedWorkflow["source"], evidence: string): LearnedWorkflow {
	const now = Date.now();
	return {
		id: randomUUID(),
		title,
		note,
		source,
		createdAt: now,
		updatedAt: now,
		evidence: evidence ? [evidence] : [],
	};
}

export function mergeLearnedWorkflows(existing: LearnedWorkflow[], additions: LearnedWorkflow[]): LearnedWorkflow[] {
	return uniqueByTitle([...existing, ...additions]).slice(0, 24);
}

export function deriveLearnedWorkflows(run: WorkerRunRecord): LearnedWorkflow[] {
	const evidence = collectEvidence(run);
	const lower = evidence.toLowerCase();
	const source: LearnedWorkflow["source"] =
		run.role === "validator"
			? run.ok
				? "validator_success"
				: "validator_failure"
			: run.ok
				? "worker_success"
				: "worker_failure";

	const workflows: LearnedWorkflow[] = [];

	if (/docker/.test(lower)) {
		workflows.push(
			buildWorkflow(
				"Start Docker before quest checks",
				"This project referenced Docker during quest execution. Ensure Docker is running before app boot or validation.",
				source,
				evidence,
			),
		);
	}

	if (/\b(?:bun|npm|pnpm|yarn)\s+db:(?:push|migrate|seed)\b/.test(lower) || /\bdb:(?:push|migrate|seed)\b/.test(lower)) {
		workflows.push(
			buildWorkflow(
				"Run database setup before app validation",
				"Quest runs in this project may require database setup commands such as `bun db:push`, `db:migrate`, or `db:seed` before the app can validate cleanly.",
				source,
				evidence,
			),
		);
	}

	if (/seed/.test(lower) && /browser|playwright|page|ui|visual/.test(lower)) {
		workflows.push(
			buildWorkflow(
				"Seed data before browser validation",
				"Browser-facing validation appears to depend on seeded data. Run the seed path before visual checks when the app needs realistic state.",
				source,
				evidence,
			),
		);
	}

	if (/\b(?:bun|npm|pnpm|yarn)\s+(?:test|lint|typecheck|build)\b/.test(lower) && /not found|missing|failed|error/.test(lower)) {
		workflows.push(
			buildWorkflow(
				"Confirm repo checks before relying on them",
				"Quest validation referenced repository check commands that may be missing or failing. Confirm the canonical test/lint/typecheck/build entrypoints before trusting automated validation.",
				source,
				evidence,
			),
		);
	}

	if (workflows.length === 0 && !run.ok && run.latestToolName === "bash" && run.latestToolSummary) {
		workflows.push(
			buildWorkflow(
				`Review prerequisite command: ${run.latestToolSummary.slice(0, 48)}`,
				"This project exposed a repeated prerequisite during quest execution. Review the last failing command and promote it into a stable local workflow if it is expected.",
				source,
				evidence,
			),
		);
	}

	return uniqueByTitle(workflows);
}
