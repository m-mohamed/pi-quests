# Design: Frontier Evals Optimization

## Summary

Quest now implements the optimization loop as a Pi-native frontier system rooted in `.pi/quests/evals/`.
The design keeps raw Pi session JSONL as the source of truth, uses native local and FrontierSWE evals for objective scoring, and promotes only non-dominated candidates that also pass hold-out validation.

## Decision 1: Canonical root is `.pi/quests/evals/`

**Decision:** The only live optimization root is `.pi/quests/evals/`.

**Rationale:**

- The eval optimizer belongs to the Quest extension.
- Frontier operation needs one canonical state root for status, candidates, community stats, and eval splits.

**Consequences:**

- New runtime state depends only on `.pi/quests/evals/`.
- Unsupported pre-cutover state fails loudly and must be recreated explicitly.

## Decision 2: Pi-native community traces stay raw

**Decision:** Community ingestion operates directly on raw Pi session `.jsonl` files.

**Rationale:**

- Pi session events contain the full tool/message/compaction timeline.
- Converting them into older Quest trace bundles would lose information and add translation bugs.

**Consequences:**

- The analyzer filters by the first record being `type: "session"`.
- Canonical community stats are written to `.pi/quests/evals/community-stats.json`.
- Non-Pi or non-session files are excluded from canonical per-source stats.

## Decision 3: Candidate-centric filesystem

**Decision:** The optimizer archives every evaluated candidate under `candidates/NNN/`.

**Filesystem layout:**

```text
.pi/quests/evals/
├── state.json
├── current/
│   └── profile.json
├── profiles/
│   └── <profile-id>.json
├── candidates/
│   ├── 000/
│   │   ├── profile.json
│   │   ├── profile.patch.json
│   │   ├── scores.json
│   │   ├── hold-out.json
│   │   ├── summary.json
│   │   └── evals/<split>/<task-id>/...
│   └── 001/
├── search-set.json
├── hold-out-set.json
├── frontier.json
├── community-traces/
└── community-stats.json
```

**Consequences:**

- Candidate `000` is always the archived baseline.
- Search and hold-out eval artifacts are kept with the candidate that produced them.
- The proposer reads a stable filesystem instead of relying on prompt-only summaries.

## Decision 4: Search/hold-out scoring with Pareto frontier selection

**Decision:** Search drives optimization; hold-out is a hard non-regression gate; frontier membership is determined by mean score, total cost, and total duration.

**Rationale:**

- Accuracy-only promotion overfits.
- Cost and duration matter for practical eval progress.
- Hold-out must stay isolated from candidate generation.

**Consequences:**

- Deterministic leader ordering is:
  1. highest `meanScore`
  2. lowest `totalCost`
  3. lowest `totalDurationMs`
- Hold-out never participates in domination checks.
- Hold-out regressions are rejected with no override.

## Decision 5: Proposer is the optimization agent

**Decision:** Candidate generation runs through the `proposer` role.

**Rationale:**

- The proposer is explicitly scoped to patch profile-owned surfaces.
- The evaluator path should be separate from the agent that proposes changes.

**Consequences:**

- The proposer reads `community-stats.json`, `search-set.json`, `hold-out-set.json`, `frontier.json`, and prior candidate artifacts.
- The proposer cannot mutate runtime code. It only emits profile patches.

## Decision 6: Default eval target is the FrontierSWE sample suite

**Decision:** The default external eval target is `frontierswe-sample@v1`.

**Rationale:**

- It is the smallest vendored long-horizon suite that exercises the real Docker agent/verifier pipeline.
- The same runtime can then be promoted to `frontierswe@public-v1` without architectural changes.

**Consequences:**

- The vendored sample suite stays small enough for fast local iteration.
- The deterministic default split remains seeded and reproducible.
