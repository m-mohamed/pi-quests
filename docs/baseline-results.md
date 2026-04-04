# Verified Baseline Results

Last verified: 2026-04-04

This document records the current reproducible benchmark baseline for Quest.
It is intentionally conservative: only official-run paths and commands that
have been executed successfully are listed here.

## Package gate

- `npm run check`: passing
- `npm run typecheck`: passing
- `npm pack --dry-run`: passing
- `quest-headless`: verified from installed/tarball context

## Terminal-Bench via Harbor (current baseline)

- Harness: Harbor
- Dataset: `terminal-bench-sample@2.0`
- Model: `opencode-go/minimax-m2.5`
- Thinking: `high`
- Adapter: `quest-installed` / `quest-bench-v1`
- Run artifact:
  - `benchmarks/.runs/harbor/sample/2026-04-03__20-35-56/result.json`
- Task artifact:
  - `benchmarks/.runs/harbor/sample/2026-04-03__20-35-56/chess-best-move__Vh5oBLy/`

Observed result:

- trials: `1`
- errors: `0`
- mean reward: `0.0`
- Duration: ~3 minutes
- Token usage: ~10K input, ~9K output (~$0.02/task)

Interpretation:

- Full pipeline working: Harbor spawns Docker, installs Node.js 20+, installs pi,
  injects auth credentials, Quest runs minimax-2.5, model produces real output.
- Reward 0.0 because agent's chess move (Re8+) didn't match expected answers (g2g4, e2e4).
- Plumbing is complete; agent quality is the next optimization target.

## Historical baselines (superseded)

### Gemini baselines (incorrect model selection)

The baselines below were run with `google/gemini-2.5-flash` due to incorrect
model selection in `defaultBenchmarkModel()`. They are kept for plumbing
verification only and do not represent Quest's actual capability.

**Terminal-Bench:**
- `benchmarks/.runs/harbor/sample/2026-04-03__14-31-24/`

**SlopCodeBench:**  
- `benchmarks/.runs/slopcodebench/official/gemini-2.5-flash/`

## How to run baselines

```bash
# Terminal-Bench sample (1 task)
npm run benchmark:tbench:preflight
npm run benchmark:tbench:sample -- --max-tasks 1

# Terminal-Bench full dataset
npm run benchmark:tbench:sample
npm run benchmark:tbench:full

# SlopCodeBench official (requires cloned repo at /tmp/slop-code-bench)
npm run benchmark:slop:official -- --problem <problem-id>
```

## Next steps

- Trials can now optimize against real benchmark traces.
- Profile tuning: prompt policies, thinking budgets, context handling.
- Model upgrades: test stronger models (GPT-5.4, etc.) against same tasks.
- Ground truth: `blueprints/changes/improve-benchmark-baselines/`
