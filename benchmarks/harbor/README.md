# Harbor Integration

This directory contains the Quest adapter for [Harbor](https://harborframework.com/docs/agents), the benchmark harness used by Terminal-Bench.

The integration path is:

1. Harbor invokes `benchmarks.harbor.quest_installed_agent:QuestInstalledAgent`
2. the installed agent runs `quest-headless`
3. Quest writes machine-readable benchmark artifacts under `.pi/quests/<quest-id>/headless-run.json`
4. Trials ingest the resulting traces and replay cases

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

The preflight checks Harbor, Docker, `quest-headless`, and model credentials before the real sample or full run. The Harbor adapter compiles the current Quest checkout into a mounted headless bundle so the benchmark run reflects the current local package state without paying per-task npm install costs inside the task container.
