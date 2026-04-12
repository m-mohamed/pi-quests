# Verified Baseline Results

Last updated: 2026-04-11

This document records the current reproducible benchmark and optimization facts for Quest.
It is the canonical human-readable benchmark status document for this repo.
Use `.pi/quests/trials/community-stats.json` as the canonical numeric source for community-trace counts and `.pi/quests/trials/candidates/` as the canonical source for archived candidate artifacts.

## Package gate

- `npm run check`: passing
- `npm run typecheck`: passing
- `npm run test`: passing
- `npm run internal:benchmark:tbench:preflight`: smoke succeeds, integrity gate fails closed
- `npm pack --dry-run`: passing

## Terminal-Bench via Harbor

- Harness: Harbor (Docker)
- Canonical sample dataset: `terminal-bench-sample@2.0`
- Sample dataset size: 10 tasks
- Canonical Trials split: 7 search / 3 hold-out with seed `42`
- Full dataset identifier: `terminal-bench@2.0`

Prepared sample split on 2026-04-07:

- Search:
  - `build-cython-ext`
  - `qemu-startup`
  - `fix-code-vulnerability`
  - `polyglot-c-py`
  - `configure-git-webserver`
  - `chess-best-move`
  - `regex-log`
- Hold-out:
  - `sqlite-with-gcov`
  - `log-summary-date-ranges`
  - `qemu-alpine-ssh`

### Current status

- Harbor smoke succeeds against the current local checkout.
- Harbor integrity still fails closed because the verifier reuses a mutable environment, so trusted public Terminal-Bench scoring remains blocked.
- Current Harbor integrity issue codes:
  - `shared_phase_environment`
  - `mutable_system_state_survives_verification`
- Latest verified Harbor smoke artifact:
  - `benchmarks/.runs/harbor/preflight-smoke/2026-04-11__16-18-08/regex-log__frdDUXZ/agent/quest-headless-output.json`
- The frontier Trials pipeline is wired end-to-end in code:
  - benchmark split preparation
  - community trace analysis
  - baseline candidate `000`
  - proposer-driven candidate iterations
  - Pareto frontier recomputation
- The trials runtime now treats interrupted or failed Harbor runs as explicit `partial` or `failed` candidates instead of leaving `state.json` wedged in `running`.
- Only complete canonical candidates with both `scores.json` and `hold-out.json` participate in `frontier.json`.
- The local sample baseline candidate `000` should currently be treated as a partial recovery artifact until Harbor integrity is fixed and a clean Harbor sample rerun archives a complete `summary.json`, `scores.json`, and `hold-out.json`.
- No public score claim should be made until the official Harbor path is both complete and integrity-clean.

## Community traces

Canonical location: `.pi/quests/trials/community-traces/`

Canonical counts live in `.pi/quests/trials/community-stats.json`.

| Source | Valid Pi sessions |
|--------|-------------------|
| `badlogicgames/pi-mono` | 626 |
| `badlogicgames/pi-diff-review` | 6 |
| `0xSero/pi-sessions` | 95 |
| `LarsEckart/approvaltests-java-sessions` | 14 |
| `championswimmer/pi-coding-sessions` | 25 |
| `cfahlgren1/agent-sessions-list/sessions/pi` | 2 |
| **Total valid Pi sessions** | **768** |

Additional corpus facts:

- Total `.jsonl` files on disk: `777`
- Non-session or non-Pi files excluded from canonical stats: `9`
- Canonical community stats file: `.pi/quests/trials/community-stats.json`

## Trials frontier layout

Canonical optimization root: `.pi/quests/trials/`

- `state.json`
- `current/profile.json`
- `profiles/<profile-id>.json`
- `candidates/NNN/profile.json`
- `candidates/NNN/profile.patch.json`
- `candidates/NNN/scores.json`
- `candidates/NNN/hold-out.json`
- `candidates/NNN/summary.json`
- `candidates/NNN/traces/<task-name>/...`
- `search-set.json`
- `hold-out-set.json`
- `frontier.json`
- `community-traces/`
- `community-stats.json`

Runtime code reads only `.pi/quests/trials/` for frontier state.

## How to run the frontier pipeline

```bash
npm run internal:benchmark:tbench:integrity
npm run internal:benchmark:tbench:preflight

/quest trials prepare-benchmark
/quest trials analyze-community --force
/quest trials baseline
/quest trials run
```

## Next steps

1. Fix the Harbor integrity blocker so the official Terminal-Bench path can be trusted again.
2. Rerun the Harbor sample baseline cleanly until candidate `000` is archived with the canonical candidate files.
3. Run the first real proposer iteration through `/quest trials run` only after candidate `000` is complete.
