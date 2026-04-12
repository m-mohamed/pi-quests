# Blueprints Project Context

## Purpose

`@m-mohamed/pi-quests` is a Pi-native package for long-running autonomous
coding. Pi stays upstream as the primitive runtime. Quest adds proposal-first,
validation-first orchestration. Trials adds evals-and-traces optimization.

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
- Harbor smoke succeeds, but the integrity gate still fails closed and blocks trusted Terminal-Bench score claims.
- Official SlopCodeBench runner path works with Quest overlay.
- Multiple models tested: minimax-m2.5, glm-5, kimi-k2.5 all produce real output.
- All models return 0.0 reward on chess task (agent quality gap, not plumbing).
- Canonical community-trace counts live in `.pi/quests/trials/community-stats.json`.
- Canonical benchmark status and baseline interpretation live in `docs/internal/baseline-results.md`.

## Working Agreement

- Capability docs in `blueprints/capabilities/` describe the current intended
  system behavior.
- Change docs in `blueprints/changes/` describe the next planned deltas.
- Benchmark improvement work starts from the latest verified baseline and keeps
  replayable traces attached to any claimed improvement.
