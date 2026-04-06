# Benchmarking Capability

## Purpose

Define how Quest is evaluated on local substrate checks and official external
benchmarks.

## Current Commitments

### Distinct local and official benchmark paths

Quest distinguishes local smoke workflows from official public benchmark runs.

#### Scenario: Operator runs a local smoke command

- GIVEN an operator runs a local benchmark smoke script
- WHEN the script completes
- THEN the results are treated as development substrate only
- AND they are not presented as official benchmark claims

### Official benchmark adapters

Quest provides official-run adapters for supported external benchmarks.

#### Scenario: Operator runs an official benchmark command

- GIVEN an operator runs Harbor or the official SlopCodeBench runner path
- WHEN Quest completes the run
- THEN the adapter preserves machine-readable Quest artifacts
- AND the benchmark result reflects official harness output

### Benchmark provenance

Quest attaches benchmark provenance to Quest outputs and trace bundles.

#### Scenario: Benchmark run writes artifacts

- GIVEN a benchmark-backed Quest run completes
- WHEN the result artifacts are written
- THEN they record benchmark name, dataset, run mode, model, and adapter version
- AND they preserve references to Quest trace bundles

### Search/hold-out isolation

Benchmark tasks are split into search and hold-out sets.

#### Scenario: Task sets are isolated

- GIVEN benchmark task IDs
- WHEN the meta-harness initializes
- THEN 70% of tasks are in search-set.json
- AND 30% of tasks are in hold-out-set.json
- AND there is no overlap between sets

#### Scenario: Hold-out is never used for optimization

- GIVEN a candidate is being evaluated
- WHEN scores are computed for optimization
- THEN only search-set tasks contribute to the score
- AND hold-out scores are computed for validation only
- AND candidates that regress on hold-out are rejected