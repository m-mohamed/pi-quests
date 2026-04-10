import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface HarborRuntimePaths {
	harborPath: string;
	pythonPath: string;
}

export async function resolveHarborExecutable(): Promise<string> {
	const harborExecutable = process.env.HARBOR_BIN ?? process.env.HARBOR_CLI ?? "/Users/mohamedmohamed/.local/bin/harbor";
	const harborPath = existsSync(harborExecutable) ? harborExecutable : "harbor";
	const resolvedHarbor = harborPath === "harbor"
		? await realpath("/Users/mohamedmohamed/.local/bin/harbor").catch(() => null)
		: await realpath(harborPath).catch(() => null);
	if (!resolvedHarbor) {
		throw new Error("Unable to locate the Harbor executable needed for benchmark runtime introspection.");
	}
	return resolvedHarbor;
}

export async function resolveHarborPython(): Promise<string> {
	const harborPath = await resolveHarborExecutable();
	const pythonPath = join(dirname(harborPath), "python");
	if (!existsSync(pythonPath)) {
		throw new Error("Unable to locate Harbor's Python runtime for dataset metadata loading.");
	}
	return pythonPath;
}

export async function resolveHarborRuntime(): Promise<HarborRuntimePaths> {
	const harborPath = await resolveHarborExecutable();
	const pythonPath = join(dirname(harborPath), "python");
	if (!existsSync(pythonPath)) {
		throw new Error("Unable to locate Harbor's Python runtime for benchmark introspection.");
	}
	return { harborPath, pythonPath };
}
