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
- THEN they record benchmark name, dataset, run mode, model, and adapter
  version
- AND they preserve references to Quest trace bundles
