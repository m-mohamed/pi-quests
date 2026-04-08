# Verified Baseline Results

Last verified: 2026-04-07

This document records the current reproducible benchmark and optimization facts for Quest.
It is intentionally conservative: only commands and artifact shapes that have been validated locally are listed here.

## Package gate

- `npm run check`: passing
- `npm run typecheck`: passing
- `npm run test`: passing
- `npm run benchmark:tbench:preflight`: passing
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

- Harbor preflight succeeds against the current local checkout.
- The frontier Trials pipeline is wired end-to-end in code:
  - benchmark split preparation
  - community trace analysis
  - baseline candidate `000`
  - proposer-driven candidate iterations
  - Pareto frontier recomputation
- A live `/quest trials baseline` launch was verified through Harbor job creation and task startup with the canonical 7-task search split.
- That run was interrupted during container-side agent setup, so no candidate was archived and no benchmark numbers are recorded here yet.

## Community traces

Canonical location: `.pi/quests/trials/community-traces/`

Verified on 2026-04-07:

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

Legacy roots such as `.pi/quests/lab` and `.pi/quests/meta-harness` are migration inputs only.

## How to run the frontier pipeline

```bash
npm run benchmark:tbench:preflight

/quest trials prepare-benchmark
/quest trials analyze-community --force
/quest trials baseline
/quest trials run
```

## Next steps

1. Run and archive the first official Harbor sample baseline through `/quest trials baseline`.
2. Run the first real proposer iteration through `/quest trials run`.
3. Promote the same pipeline from `terminal-bench-sample@2.0` to `terminal-bench@2.0`.
