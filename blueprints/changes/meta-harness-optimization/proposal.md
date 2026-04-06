# Proposal: Meta-Harness Optimization

## Why

Current baselines are weak. Meta-Harness showed that agents with **full trace access** (10M tokens vs 26K compressed) beat prior methods by 10-49 points through counterfactual diagnosis.

We're Pi-native. The Pi community shares traces (badlogicgames: 627, 0xSero: 96). Quest has Trials. We can learn from both.

**The gap:** Quest trace bundles are derived summaries. Community traces are raw Pi sessions. We need Pi-native trace processing and a filesystem-based proposer.

## What changes

1. **Pi-native trace format** — Use raw Pi session JSONL directly, don't convert
2. **Community trace ingestion** — Sync with HuggingFace, derive failure signals
3. **Meta-harness filesystem** — Candidates, scores, traces as queryable files
4. **Proposer agent** — Quest extension that reads filesystem, proposes patches
5. **Search/hold-out split** — 70% search, 30% validation, Pareto frontier selection

## Expected outcome

- Measurable improvement on Terminal-Bench within 5 iterations
- Profile improvements that transfer across model upgrades
- Community traces improve failure tag derivation

## Commitments

- Fail loudly: no silent fallbacks
- Fail early: validate before expensive runs
- No legacy: delete unused code, don't deprecate
- Pi-native: work with Pi session format directly