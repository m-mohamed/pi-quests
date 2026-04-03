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

4. Scenario evals
   - slower
   - exercise live Pi subprocesses and fixture repos
   - cover compatibility, proposal capture, weak validation warnings, abort/recovery, and validator-triggered replans

## Commands

The publish-ready package currently gates on the standard npm checks:

```bash
npm run typecheck
npm run test
npm run check
npm run pack:check
```

Manual scenario and smoke harnesses still live under `scripts/`, but they are not wired into the publish gate.

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

Scenario suite:

- Pi child JSON compatibility
- readonly proposal capture without repo pollution
- weak-validation warning capture
- explicit human QA gate
- abort and recovery
- validator-triggered replan

## What These Evals Do Not Cover

- end-to-end model quality across every provider/model combination
- subjective UX quality in the TUI
- whether a specific repo has strong enough validation for high-confidence quests

Those still require manual review and real quest runs.
