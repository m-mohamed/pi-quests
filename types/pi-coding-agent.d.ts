declare module "@mariozechner/pi-coding-agent" {
	import type { Model } from "@mariozechner/pi-ai";

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		model: Model<unknown> | null;
		isIdle(): boolean;
		sessionManager: {
			getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
		};
		modelRegistry: {
			getAvailable(): Promise<Array<{ id: string; provider: string }>>;
		};
		ui: {
			theme: {
				fg(color: string, text: string): string;
			};
			notify(message: string, level?: "info" | "warning" | "error"): void;
			select(title: string, options: string[], initialValue?: string): Promise<string | null>;
			setStatus(key: string, value: string | undefined): void;
			setWidget(key: string, lines: string[] | undefined): void;
		};
	}

	export interface ExtensionAPI {
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
				handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
			},
		): void;
		registerMessageRenderer(
			customType: string,
			renderer: (message: { content: unknown }, context: unknown, theme: { fg(color: string, text: string): string }) => unknown,
		): void;
		sendMessage(message: Record<string, unknown>, options?: { triggerTurn?: boolean }): void;
		sendUserMessage(message: string, options?: { deliverAs?: "followUp" | "message" }): void;
		appendEntry<T = unknown>(customType: string, data?: T): void;
		setModel(model: { id: string; provider: string }): Promise<boolean>;
		setThinkingLevel(level: string): void;
		getThinkingLevel(): string;
		on(
			event: string,
			handler: (
				event: any,
				ctx: ExtensionContext,
			) =>
				| Promise<
						| void
						| { message?: Record<string, unknown> }
						| { action: "continue" | "handled" }
						| { action: "transform"; text: string }
				  >
				| void
				| { message?: Record<string, unknown> }
				| { action: "continue" | "handled" }
				| { action: "transform"; text: string },
		): void;
	}

	export function getAgentDir(): string;
}
