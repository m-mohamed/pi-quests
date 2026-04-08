# Tasks: Meta-Harness Optimization

> Status date: 2026-04-07
> Canonical optimization root: `.pi/quests/trials/`
> Goal: reach the first reproducible Terminal-Bench baseline through the frontier Trials loop without depending on legacy lab or meta-harness runtime paths.

## Outcome

The core frontier infrastructure is now implemented in the Quest extension:

- Pi-native community trace ingestion is live.
- Canonical Trials storage is candidate-centric under `.pi/quests/trials/`.
- The `proposer` role drives profile patch generation.
- Search and hold-out splits are explicit benchmark artifacts.
- Candidate archiving, hold-out gating, Pareto frontier selection, and deterministic leader promotion are implemented.
- Legacy `.pi/quests/lab` and `.pi/quests/meta-harness` roots are migration inputs only.

## Implemented

### 1. Canonical Trials root

- [x] Extend `QuestTrialPaths` to support `current/`, `candidates/`, `search-set.json`, `hold-out-set.json`, `frontier.json`, `community-traces/`, and `community-stats.json`
- [x] Persist the active leader profile to `.pi/quests/trials/current/profile.json`
- [x] Archive each candidate under `candidates/NNN/`

### 2. Migration and legacy retirement

- [x] Import active profile and state from `.pi/quests/lab` when `.pi/quests/trials/state.json` is missing
- [x] Import only valid split/community artifacts from `.pi/quests/meta-harness`
- [x] Ignore broken symlinks and inconsistent split metadata
- [x] Stop using legacy roots in the live runtime after migration

### 3. Pi-native trace analysis

- [x] Fix Pi session types for real corpus shapes:
  - optional `id`, `parentId`, `version`
  - `thinkingLevel`
  - object-valued tool-call `arguments`
  - `session_info.name`
  - real compaction payloads
  - unknown event passthrough
- [x] Implement `src/trace-analyzer.ts`
- [x] Count only files whose first record is `type: "session"`
- [x] Exclude non-Pi/non-session files from canonical per-source stats
- [x] Write canonical aggregate stats to `.pi/quests/trials/community-stats.json`

### 4. Frontier runtime

- [x] Vendor the official `terminal-bench-sample@2.0` 10-task manifest
- [x] Implement deterministic 7/3 search/hold-out preparation with seed `42`
- [x] Implement baseline candidate `000`
- [x] Replace the legacy trial-agent optimization path with the `proposer` role
- [x] Score candidates on:
  - mean score
  - total cost
  - total duration
- [x] Reject hold-out regressions
- [x] Recompute the Pareto frontier and promote the deterministic leader

### 5. CLI integration

- [x] Add `/quest trials prepare-benchmark`
- [x] Add `/quest trials analyze-community`
- [x] Add `/quest trials baseline`
- [x] Add `/quest trials run`
- [x] Add `/quest trials status`
- [x] Keep `/quest trials profile` and `/quest trials stop`
- [x] Remove the live dependency on replay-era trial subcommands from the frontier runtime

### 6. Verification

- [x] Parser and analyzer tests cover:
  - session-only filtering
  - optional ids/version
  - real compaction events
  - unknown events
  - per-source aggregation
  - manifest/non-session exclusion
- [x] Migration tests cover:
  - lab import
  - inconsistent split rejection
  - broken symlink ignore
- [x] Frontier tests cover:
  - deterministic benchmark split
  - baseline candidate `000`
  - proposer candidate `001`
  - Pareto leader promotion
  - hold-out regression rejection
- [x] `npm run typecheck`
- [x] `npm run test`
- [x] `npm run benchmark:tbench:preflight`

## Verified facts

- [x] `terminal-bench-sample@2.0` contains 10 tasks
- [x] `terminal-bench@2.0` remains the full-dataset identifier
- [x] Current sample split is 7 search / 3 hold-out
- [x] Current corpus contains 777 `.jsonl` files
- [x] Current canonical Pi session count is 768 valid session files
- [x] Current canonical per-source counts are:
  - `badlogicgames/pi-mono`: 626
  - `badlogicgames/pi-diff-review`: 6
  - `0xSero/pi-sessions`: 95
  - `LarsEckart/approvaltests-java-sessions`: 14
  - `championswimmer/pi-coding-sessions`: 25
  - `cfahlgren1/agent-sessions-list/sessions/pi`: 2

## Remaining work

### 1. First official Harbor baseline

- [ ] Run `/quest trials baseline` against the real sample split and archive candidate `000` with real Harbor artifacts
- [ ] Record the resulting benchmark metrics in `docs/baseline-results.md`

### 2. First real optimization iteration

- [ ] Run `/quest trials run --iterations 1` with real benchmark credits
- [ ] Inspect proposer rationale and candidate artifacts under `candidates/001/`
- [ ] Confirm the promoted frontier leader is justified by real search and hold-out scores

### 3. Full-dataset promotion

- [ ] Run the same pipeline against `terminal-bench@2.0`
- [ ] Record the first full-dataset frontier baseline
