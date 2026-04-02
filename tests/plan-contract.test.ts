import { describe, expect, test } from "bun:test";
import { parseQuestPlanText, synthesizeValidationContract } from "../src/plan-core.js";

describe("quest plan parsing", () => {
	test("synthesizes a validation contract when one is not provided", () => {
		const contract = synthesizeValidationContract(
			[
				{
					id: "m1",
					title: "Walking skeleton",
					summary: "Boot the app",
					successCriteria: ["The app boots and renders"],
					status: "pending",
				},
			],
			[
				{
					id: "f1",
					title: "Render the shell",
					summary: "Render the app shell",
					milestoneId: "m1",
					acceptanceCriteria: ["The page renders in the browser", "The repo test command passes"],
					status: "pending",
				},
			],
			["The app is usable"],
		);

		expect(contract.criteria).toHaveLength(2);
		expect(contract.criteria[0]?.proofStrategy).toBe("browser");
		expect(contract.criteria[1]?.proofStrategy).toBe("command");
		expect(contract.featureChecks[0]?.criterionIds).toHaveLength(2);
	});

	test("parses proposal JSON and preserves explicit validation contract metadata", () => {
		const parsed = parseQuestPlanText(`
\`\`\`json
{
  "title": "Arrow",
  "summary": "Factory-style project management MVP",
  "successCriteria": ["Ship a validated MVP"],
  "milestones": [
    {
      "id": "m1",
      "title": "Walking skeleton",
      "summary": "Boot the app",
      "successCriteria": ["The app boots cleanly"]
    }
  ],
  "features": [
    {
      "id": "f1",
      "title": "Shell",
      "summary": "Render the shell",
      "milestoneId": "m1",
      "acceptanceCriteria": ["The app shell renders"]
    }
  ],
  "validationContract": {
    "summary": "Browser-first validation",
    "milestoneExpectations": [
      {
        "milestoneId": "m1",
        "title": "Walking skeleton",
        "expectedBehaviors": ["The app shell renders"]
      }
    ],
    "featureChecks": [
      {
        "featureId": "f1",
        "title": "Shell",
        "criterionIds": ["criterion-1"]
      }
    ],
    "criteria": [
      {
        "id": "criterion-1",
        "title": "Shell renders",
        "milestoneId": "m1",
        "featureIds": ["f1"],
        "expectedBehavior": "The app shell renders",
        "proofStrategy": "browser",
        "proofDetails": "Load the page and confirm the shell is visible.",
        "commands": [],
        "confidence": "high"
      }
    ],
    "weakValidationWarnings": ["Visual QA still required for final polish."]
  }
}
\`\`\`
`);

		expect(parsed).not.toBeNull();
		expect(parsed?.plan.validationContract.summary).toBe("Browser-first validation");
		expect(parsed?.plan.validationContract.criteria[0]?.proofStrategy).toBe("browser");
		expect(parsed?.plan.validationContract.weakValidationWarnings).toContain("Visual QA still required for final polish.");
	});
});
