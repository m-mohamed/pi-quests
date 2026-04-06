# Verified Baseline Results

Last verified: 2026-04-06

This document records the current reproducible benchmark baseline for Quest.
It is intentionally conservative: only official-run paths and commands that
have been executed successfully are listed here.

## Package gate

- `npm run check`: passing
- `npm run typecheck`: passing
- `npm pack --dry-run`: passing
- `quest-headless`: verified from installed/tarball context

## Terminal-Bench via Harbor

- Harness: Harbor (Docker)
- Dataset: `terminal-bench-sample@2.0` (single task: chess-best-move)
- Adapter: `quest-installed` / `quest-bench-v1`

### Model Comparison (2026-04-03 to 2026-04-04)

| Model | Thinking | Duration | Input Tokens | Output Tokens | Cost | Reward | Errors |
|-------|----------|----------|--------------|---------------|------|--------|--------|
| `opencode-go/minimax-m2.5` | high | ~3m | ~10K | ~9K | $0.02 | 0.0 | 0 |
| `opencode-go/glm-5` | default | ~6m | ~13K | ~6K | $0.04 | 0.0 | 0 |
| `opencode-go/kimi-k2.5` | default | ~6m | ~13K | ~13K | $0.05 | 0.0 | 0 |
| `opencode-go/minimax-m2.7` | xhigh | >10m | >49K | >10K | >$0.04 | 0.0 | timeout |
| `openai-codex/gpt-5.4` | xhigh | ~3m | 0 | 0 | $0.00 | 0.0 | auth timeout |

### Working Models

- `opencode-go/minimax-m2.5` — Fastest, cheapest, reliable. Recommended baseline.
- `opencode-go/glm-5` — Good throughput, moderate cost.
- `opencode-go/kimi-k2.5` — Higher output tokens, moderate cost.

All three produce real output. The pipeline is complete: Docker spawns, Node.js 20+
installs, pi installs, auth injects, models respond.

### Non-Working Models

- `openai-codex/gpt-5.4:xhigh` — OAuth token stale, needs refresh.

### Failure Pattern

All models return reward 0.0:
- Agent plays: `e2e8` (Re8+, rook check)
- Expected: `g2g4` or `e2e4` (pawn moves delivering checkmate)

This is an agent quality gap, not a plumbing gap.

### Run Artifacts

- `benchmarks/.runs/harbor/sample/` — all Harbor sample runs
- Latest working: `2026-04-04__00-42-04/` (kimi-k2.5)

## SlopCodeBench via Official Runner

- Runner: upstream `slop-code run`
- Adapter: `quest.yaml` overlay
- Provider added: `opencode-go` in `/tmp/slop-code-bench/configs/providers.yaml`
- Model added: `minimax-m2.5` in `/tmp/slop-code-bench/configs/models/`

### Status

- Plumbing validated: provider/model configs work
- No completed runs yet — needs longer timeout or CI environment

## Community Traces

Downloaded from HuggingFace for Trials optimization:

| Dataset | Sessions | Size | Source |
|---------|----------|------|--------|
| `badlogicgames/pi-mono` | 627 | 218 MB | Pi creator's development traces |
| `0xSero/pi-sessions` | 96 | 23 MB | Community member |
| **Total** | **723** | **241 MB** | |

Models in community traces: GPT-5.x, Claude Opus 4.x, GLM-5, Kimi, MiniMax

Location: `.pi/quests/trials/community-traces/`

## How to Run Baselines

```bash
# Terminal-Bench sample (1 task)
npm run benchmark:tbench:preflight
npm run benchmark:tbench:sample -- --max-tasks 1

# Terminal-Bench with specific model
npm run benchmark:tbench:sample -- --model opencode-go/minimax-m2.5

# SlopCodeBench official (requires /tmp/slop-code-bench)
npm run benchmark:slop:official -- --problem <problem-id>
```

## Next Steps

1. **More tasks needed** — Terminal-Bench sample has only 1 task. Full dataset required for meaningful optimization.
2. **Community traces** — Ingest into Trials for failure pattern derivation.
3. **Meta-harness proposer** — Read filesystem of traces, propose profile patches.

## Changelog

- 2026-04-06: Removed Gemini baselines. Documented all OpenAI Codex and OpenCode Go model tests. Added community traces section.
- 2026-04-04: Initial baseline with minimax-m2.5. Fixed Docker auth injection for OpenCode Go.