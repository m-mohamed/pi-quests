import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface QuestSubcommandContext {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	emitNote: (content: string, level?: "info" | "warning" | "error") => Promise<void>;
}

export interface QuestSubcommandProvider {
	name: string;
	description: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }>;
	handler: (args: string, context: QuestSubcommandContext) => Promise<void>;
}

const providers = new Map<string, QuestSubcommandProvider>();

export function registerQuestSubcommand(provider: QuestSubcommandProvider): void {
	providers.set(provider.name, provider);
}

export function unregisterQuestSubcommand(name: string): void {
	providers.delete(name);
}

export function getQuestSubcommand(name: string): QuestSubcommandProvider | null {
	return providers.get(name) ?? null;
}

export function listQuestSubcommands(): QuestSubcommandProvider[] {
	return [...providers.values()].sort((left, right) => left.name.localeCompare(right.name));
}
