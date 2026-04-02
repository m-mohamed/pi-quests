# Quest Evals

`pi-quests` is now developed eval-first.

The eval posture is intentionally split into three layers:

1. Regression evals
   - deterministic
   - code-graded
   - release-gating
   - focused on invariants the extension must not regress

2. Capability evals
   - deterministic
   - code-graded
   - focused on quest-orchestration quality
   - checks that prompts, scope boundaries, validation rules, and read-only validator behavior stay intact

3. Human interactive review
   - still required
   - covers TUI feel, Quest Control ergonomics, proposal-review flow, and final QA handoff

## Commands

```bash
bun run evals
bun run evals:regression
bun run evals:capability
```

`bun run verify` gates on:

- `bun test`
- regression evals
- smoke validation against the installed Pi binary

## Current Suites

Regression suite:

- validation contract synthesis
- explicit contract parsing
- live telemetry tracking
- passive read behavior
- private learned workflow persistence

Capability suite:

- planning prompt stays proposal-first and validation-first
- revision prompt only edits unfinished work
- worker prompt remains single-feature and validation-aware
- validator prompt remains read-only and explicit about weak validation

## What These Evals Do Not Cover

- end-to-end model quality across every provider/model combination
- subjective UX quality in the TUI
- whether a specific repo has strong enough validation for high-confidence quests

Those still require manual review and real quest runs.
