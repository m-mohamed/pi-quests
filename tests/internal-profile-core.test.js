import assert from "node:assert/strict";
import test from "node:test";
import {
	applyQuestProfilePatch,
	defaultInternalQuestProfile,
	parseQuestExperimentCandidate,
} from "../src/internal-profile-core.js";

test("defaultInternalQuestProfile keeps optimizer-specific benchmark defaults", () => {
	const profile = defaultInternalQuestProfile("project-123");
	assert.match(profile.promptSurfaces.planningPolicy, /eval cohorts/i);
	assert.match(profile.promptSurfaces.workerPolicy, /benchmark/i);
	assert.match(profile.promptSurfaces.proposerPolicy, /search-set mean score/i);
	assert.match(profile.harnessPolicy.computationalGuides.structuralTests.join(" "), /Harbor smoke/i);
});

test("internal proposer candidates parse and patch internal profile-owned surfaces", () => {
	const profile = defaultInternalQuestProfile("project-123");
	const candidate = parseQuestExperimentCandidate(`{
  "summary": "Tighten worker policy",
  "rationale": "Improve generalization on benchmark search tasks.",
  "generalizationNote": "Targets repeated failures instead of a single trace.",
  "targetedTags": ["weak_validation"],
  "targetedCaseIds": [],
  "promptSurfaceIds": ["feature-worker"],
  "patch": {
    "promptSurfaces": {
      "workerPolicy": "Confirm prerequisites and state validation limits explicitly."
    },
    "contextPolicy": {
      "spillLongOutputsToReports": true
    }
  }
}`);
	assert.ok(candidate);
	assert.deepEqual(candidate.targetedTags, ["weak_validation"]);
	assert.deepEqual(candidate.promptSurfaceIds, ["feature-worker"]);

	const patched = applyQuestProfilePatch(profile, candidate.patch);
	assert.match(patched.promptSurfaces.workerPolicy, /validation limits explicitly/i);
	assert.equal(patched.contextPolicy.spillLongOutputsToReports, true);
	assert.equal(patched.toolAllowlist.worker.includes("edit"), true);
});
