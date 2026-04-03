# Blueprints Project Context

## Purpose

`@m-mohamed/pi-quests` is a Pi-native package for long-running autonomous
coding. Pi stays upstream as the primitive runtime. Quest adds proposal-first,
validation-first orchestration. Trials add evals-and-traces optimization.

## North Star

Build a benchmarkable, reproducible, validation-first coding agent stack that
can improve itself through bounded profile iteration instead of ad hoc prompt
tweaks.

## Guardrails

- Pi core remains upstream and unchanged.
- Quest runtime owns orchestration, not model implementation.
- Trials may tune bounded profile surfaces, but must not auto-publish,
  auto-tag, auto-release, auto-commit, or mutate arbitrary runtime code during
  task execution.
- Public benchmark claims must come from official runner paths.
- Human QA remains an explicit final boundary before shipping.

## Verified State

- Package gate is green via `npm run check`.
- Harbor-backed `terminal-bench-sample@2.0` runs complete without harness
  errors.
- The official SlopCodeBench runner path works with the Quest overlay.
- Current public baseline is documented in `docs/baseline-results.md`.

## Working Agreement

- Capability docs in `blueprints/capabilities/` describe the current intended
  system behavior.
- Change docs in `blueprints/changes/` describe the next planned deltas.
- Benchmark improvement work starts from the latest verified baseline and keeps
  replayable traces attached to any claimed improvement.
