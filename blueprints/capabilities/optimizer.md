# Optimizer Capability

## Purpose

Define how Quest turns eval evidence and community traces into bounded
profile improvements.

## Current Commitments

### Replayable eval evidence

The optimizer persists Quest traces and candidate artifacts in a replayable
filesystem.

#### Scenario: Interesting run becomes optimizer evidence

- GIVEN a quest run ends with a notable failure or weak validation signal
- WHEN the optimizer ingests the run
- THEN it persists a trace bundle
- AND it can reuse that evidence during candidate generation

### Bounded profile optimization

The optimizer limits changes to explicit profile-owned surfaces.

#### Scenario: Profile patch is applied

- GIVEN the optimizer identifies an improving candidate
- WHEN the candidate passes search and hold-out checks
- THEN it updates prompts, budgets, and policies only
- AND it does NOT mutate arbitrary runtime code

### Pi-native trace ingestion

The optimizer accepts both Quest trace bundles and raw Pi session files.

#### Scenario: Community trace is ingested

- GIVEN a raw Pi session JSONL file
- WHEN the optimizer parses the session
- THEN it derives model choice, duration, and failure signals
- AND it can use those signals for profile optimization

### Frontier filesystem

The optimizer maintains a filesystem of candidates for counterfactual reasoning.

#### Scenario: Proposer reads prior candidates

- GIVEN multiple candidates have been evaluated
- WHEN a proposer reads the frontier filesystem
- THEN it can access prior profile patches, scores, and traces
- AND it can perform counterfactual diagnosis across candidates

### Overfitting guard

The optimizer rejects candidates that improve narrow search slices while
regressing hold-out or core behavior.

#### Scenario: Hold-out regression blocks adoption

- GIVEN a candidate improves an eval search slice
- WHEN it regresses hold-out or core datasets
- THEN the optimizer rejects the candidate
- AND preserves the promoted profile
