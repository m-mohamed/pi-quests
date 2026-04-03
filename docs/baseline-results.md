# Verified Baseline Results

Last verified: 2026-04-03

This document records the current reproducible benchmark baseline for Quest.
It is intentionally conservative: only official-run paths and commands that
have been executed successfully are listed here.

## Package gate

- `npm run check`: passing
- `npm pack --dry-run`: passing
- `quest-headless`: verified from an installed/tarball context

## Terminal-Bench via Harbor

- Harness: Harbor
- Dataset: `terminal-bench-sample@2.0`
- Model: `google/gemini-2.5-flash`
- Adapter: `quest-installed` / `quest-bench-v1`
- Run artifact:
  - `benchmarks/.runs/harbor/sample/2026-04-03__14-31-24/result.json`
- Task artifact:
  - `benchmarks/.runs/harbor/sample/2026-04-03__14-31-24/chess-best-move__RXWGcUQ/result.json`

Observed result:

- trials: `1`
- errors: `0`
- mean reward: `0.0`
- Quest outcome: `blocked`

Interpretation:

- The Harbor integration is healthy.
- The benchmark is now measuring Quest behavior rather than adapter/setup
  failures.
- The current problem is agent-performance quality, not benchmark plumbing.

## SlopCodeBench official runner

- Runner: upstream `slop-code run`
- Model: `gemini-2.5-flash`
- Prompt: `just-solve`
- Thinking: `none`
- Run artifact:
  - `benchmarks/.runs/slopcodebench/official/gemini-2.5-flash/quest_just-solve_none_20260403T1335/result.json`

Observed result:

- problems: `1`
- checkpoints: `1`
- problems solved: `0.0`
- checkpoints solved: `0`
- total pass rate: `0.18181818181818182`

Interpretation:

- The official runner path works.
- Checkpoint lineage and Quest artifacts are preserved.
- The current problem is low task performance, not adapter correctness.

## What this baseline means

- Quest is benchmarkable through both Harbor and the official SlopCodeBench
  runner.
- Trials can now optimize against real external benchmark traces instead of
  only local fixtures.
- Future public claims should compare against this document, not against
  unverified local smoke runs.
- The next benchmark-improvement work is tracked in `blueprints/changes/`.
