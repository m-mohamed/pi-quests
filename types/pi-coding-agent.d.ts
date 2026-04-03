declare module "@mariozechner/pi-coding-agent" {
	import type { Model } from "@mariozechner/pi-ai";
	import type { TSchema } from "@sinclair/typebox";

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		model: Model<unknown> | null;
		isIdle(): boolean;
		signal?: AbortSignal;
		hasPendingMessages?(): boolean;
		abort?(): void;
		sessionManager: {
			getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
		};
		modelRegistry: {
			getAvailable(): Promise<Array<{ id: string; provider: string }>>;
			find(provider: string, id: string): { id: string; provider: string } | undefined;
		};
		ui: {
			theme: {
				fg(color: string, text: string): string;
				bold(text: string): string;
			};
			notify(message: string, level?: "info" | "warning" | "error"): void;
			select(title: string, options: string[], initialValue?: string): Promise<string | null>;
			setStatus(key: string, value: string | undefined): void;
			setWidget(key: string, lines: string[] | undefined): void;
			custom?<T>(
				renderer: (
					tui: { requestRender(): void },
					theme: { fg(color: string, text: string): string; bold(text: string): string },
					keybindings: unknown,
					done: (value: T) => void,
				) => {
					render(width: number): string[] | unknown;
					invalidate?(): void;
					handleInput?(data: string): boolean | void;
				},
			): Promise<T>;
		};
	}

	export interface ExtensionAPI {
		registerTool(tool: {
			name: string;
			label: string;
			description: string;
			promptSnippet?: string;
			parameters: TSchema;
			execute: (
				toolCallId: string,
				params: any,
				signal: AbortSignal | undefined,
				onUpdate: unknown,
				ctx: ExtensionContext,
			) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
		}): void;
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
		sendMessage(message: Record<string, unknown>, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
		sendUserMessage(message: string, options?: { deliverAs?: "followUp" | "steer" | "nextTurn" }): void;
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

	export function defineTool<T>(tool: T): T;
}
