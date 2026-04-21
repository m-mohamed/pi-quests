# Blueprints Project Context

## Purpose

`@m-mohamed/pi-quests` is a Pi-native package for long-running autonomous
coding. Pi stays upstream as the primitive runtime. Quest adds proposal-first,
validation-first orchestration. The eval optimizer adds bounded profile iteration.

## North Star

Build a reproducible, validation-first coding agent stack for long-running
autonomous coding that improves itself through bounded profile iteration and
high-signal evals instead of ad hoc prompt tweaks.

## Guardrails

- Pi core remains upstream and unchanged.
- Quest runtime owns orchestration, not model implementation.
- The eval optimizer may tune bounded profile surfaces, but must not auto-publish,
  auto-tag, auto-release, auto-commit, or mutate arbitrary runtime code during
  task execution.
- Reproducible eval claims must come from supported runner paths.
- Human QA remains an explicit final boundary before shipping.

## Verified State

- Package gate is green via `npm run check`.
- Native Docker FrontierSWE sample runs complete end to end.
- Legacy external harness integration code is removed from the live runtime.
- Canonical community-trace counts live in `.pi/quests/evals/community-stats.json`.
- Canonical eval status and baseline interpretation live in `packages/pi-quests-evals/docs/internal/baseline-results.md`.

## Working Agreement

- Capability docs in `blueprints/capabilities/` describe the current intended
  system behavior.
- Change docs in `blueprints/changes/` describe the next planned deltas.
- Eval improvement work starts from the latest verified baseline and keeps
  replayable traces attached to any claimed improvement.
