declare module "@sinclair/typebox" {
	export interface TSchema {
		readonly type?: string;
	}

	export const Type: {
		Object(properties: Record<string, unknown>, options?: Record<string, unknown>): TSchema;
		String(options?: Record<string, unknown>): TSchema;
		Array(item: unknown, options?: Record<string, unknown>): TSchema;
		Optional(item: unknown): TSchema;
		Boolean(options?: Record<string, unknown>): TSchema;
		Number(options?: Record<string, unknown>): TSchema;
		Union(items: unknown[], options?: Record<string, unknown>): TSchema;
		Literal(value: string | number | boolean): TSchema;
	};
}
