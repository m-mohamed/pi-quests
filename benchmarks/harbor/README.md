# Harbor Integration

This directory contains the Quest adapter for [Harbor](https://harborframework.com/docs/agents), the benchmark harness used by Terminal-Bench.

The integration path is:

1. Harbor invokes `benchmarks.harbor.quest_installed_agent:QuestInstalledAgent`
2. the installed agent runs `quest-headless`
3. Quest writes machine-readable benchmark artifacts under `.pi/quests/<quest-id>/headless-run.json`
4. Trials archive the resulting scorecards, traces, and candidate summaries under `.pi/quests/trials/`

Useful commands:

```bash
npm run benchmark:tbench:preflight
npm run benchmark:tbench:sample
npm run benchmark:tbench:full
node --import tsx benchmarks/harbor/run.ts --dataset terminal-bench-sample@2.0 --run-mode sample --dry-run
```

Official Harbor dataset identifiers:

- sample/dev slice: `terminal-bench-sample@2.0`
- full dataset: `terminal-bench@2.0`

The preflight compiles the current Quest checkout into a mounted headless bundle, checks Harbor, Docker, `quest-headless`, and model credentials, and then runs a single cheap Harbor task as an end-to-end readiness probe. That keeps sample/full runs honest: benchmark readiness means the installed agent can actually start, emit Quest JSON, and produce Harbor job artifacts, not just print `--help`.
