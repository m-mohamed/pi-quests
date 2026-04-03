declare module "@mariozechner/pi-ai" {
	export interface Model<T = unknown> {
		id: string;
		provider: string;
	}

	export interface MessageContentPart {
		type: string;
		text?: string;
		thinking?: string;
		toolName?: string;
		arguments?: Record<string, unknown>;
	}

	export interface Message {
		role: string;
		content: MessageContentPart[];
		stopReason?: string;
		errorMessage?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: {
				total?: number;
			};
		};
	}
}
