# Proposal: Frontier Evals Optimization

## Why

Current baselines are weak. Meta-Harness showed that agents with **full trace access** (10M tokens vs 26K compressed) beat prior methods by 10-49 points through counterfactual diagnosis.

We're Pi-native. The Pi community shares raw session traces, and Quest already has a Trials layer. We can learn from both without introducing a separate legacy runtime.

**The gap:** Quest trace bundles are derived summaries. Community traces are raw Pi sessions. We need Pi-native trace processing, canonical Trials storage, and a proposer-driven frontier loop on real long-horizon evals.

## What changes

1. **Pi-native trace format** — Use raw Pi session JSONL directly, don't convert
2. **Canonical Trials filesystem** — Store candidates, scores, frontier state, splits, and community stats under `.pi/quests/trials/`
3. **Community trace ingestion** — Analyze raw Pi sessions into canonical aggregate stats
4. **Proposer agent** — Quest extension role that reads frontier artifacts and proposes profile patches
5. **Search/hold-out split** — 70% search, 30% validation, Pareto frontier selection on FrontierSWE and local eval datasets

## Expected outcome

- First reproducible baseline on `frontierswe-sample@v1`
- Measurable improvement on FrontierSWE within repeated proposer iterations
- Profile improvements that transfer across model upgrades
- Community traces improve failure tag derivation

## Commitments

- Fail loudly: no silent fallbacks
- Fail early: validate before expensive runs
- No legacy runtime: migrate useful state, then operate only from `.pi/quests/trials/`
- Pi-native: work with Pi session format directly
