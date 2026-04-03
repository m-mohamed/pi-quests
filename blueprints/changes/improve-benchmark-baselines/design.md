# Design: Improve benchmark baselines

## Starting point

We already have:

- a Harbor-backed `terminal-bench-sample@2.0` baseline with no harness errors
- an official SlopCodeBench baseline through the upstream runner
- Trials datasets, replay generation, held-out checks, and bounded profile
  surfaces

The missing piece is a tighter bridge between official benchmark failures and
Trials candidate generation.

## Design

1. Treat each official benchmark run as first-class lab input.
   - Harbor runs should be replayable by task and run id.
   - SlopCodeBench runs should be replayable by problem id and checkpoint id.

2. Add benchmark-specific failure analysis.
   - blocked-without-worker-summary
   - validator-stalled
   - missing-prerequisite-handling
   - low-signal-plan
   - context-pressure

3. Keep optimization bounded to Quest profiles.
   - planning prompt
   - worker prompt
   - validator prompt
   - verification budgets
   - context spill policy
   - workflow hints
   - model-pairing policy

4. Stabilize on single-task reruns first.
   - One Harbor task rerun with the same profile/model until repeatable
   - One SlopCodeBench problem/checkpoint rerun until repeatable

5. Record every improvement attempt with before/after benchmark context.
   - baseline metric
   - replay slice used
   - held-out result
   - adopted or rejected

## Non-goals

- chasing full-dataset leaderboard runs before single-task stability exists
- benchmark-specific hacks that do not generalize back to Quest-native suites
