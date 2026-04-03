# Proposal: Improve benchmark baselines

## Why

Quest now has real baselines through Harbor and the official SlopCodeBench
runner, but the scores are weak. The next phase is to improve Quest behavior,
not to keep rebuilding benchmark plumbing.

## What changes

- add a benchmark-review workflow that starts from official result artifacts
- turn official Harbor and SlopCodeBench failures into benchmark-tagged replay
  datasets for Trials
- add benchmark-specific failure analysis and improvement reporting
- stabilize single-task reruns before attempting broader benchmark sweeps

## Expected outcome

Trials get a tighter feedback loop for Terminal-Bench and SlopCodeBench.
Improvements become trace-driven, replay-backed, and checked against held-out
Quest-native suites before adoption.
