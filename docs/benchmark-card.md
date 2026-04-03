# Quest Benchmark Card

Last reviewed: 2026-04-03

## Package

- Package: `@m-mohamed/pi-quests`
- Runtime: Pi package + extension
- Headless runner: `quest-headless`
- Benchmark adapter version: `quest-bench-v1`

## Benchmarks

### Terminal-Bench

- Harness: Harbor
- Dataset path: `terminal-bench-sample@2.0` for sample/dev runs
- Full dataset target: `terminal-bench@2.0`
- Measured axis: terminal-native coding agent performance

### SlopCodeBench

- Public site: [scbench.ai](https://www.scbench.ai/)
- Measured axis: iterative specification refinement and code-quality degradation across checkpoints
- Local adapter mode: Quest-owned checkpoint runner with benchmark provenance
- Official adapter mode: upstream `slop-code run` overlay with Quest agent registration

## What Quest adds on top of Pi

- proposal-first execution
- validation-first execution
- serial-by-default feature workers
- validator-driven blocking behavior
- explicit human QA handoff
- replayable traces for Trials optimization

## Out of scope

- auto-commit
- auto-release
- auto-publish
- benchmark gaming or benchmark-specific hidden prompt hacks

## Reporting checklist

Before publishing benchmark numbers, capture:

- benchmark name and version
- model and thinking level
- Quest profile id
- benchmark adapter version
- task slice or full dataset
- exact command used
- rerun date
- score and pass/fail interpretation
