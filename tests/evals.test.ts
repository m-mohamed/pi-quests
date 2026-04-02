import { describe, expect, test } from "bun:test";
import { runEvalSuite } from "../src/evals-core.js";

describe("quest eval suites", () => {
	test("regression suite passes", async () => {
		const result = await runEvalSuite("regression");
		expect(result.failed).toBe(0);
		expect(result.passed).toBeGreaterThan(0);
	});

	test("capability suite passes", async () => {
		const result = await runEvalSuite("capability");
		expect(result.failed).toBe(0);
		expect(result.passed).toBeGreaterThan(0);
	});
});
