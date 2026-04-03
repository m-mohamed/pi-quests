# Reproducibility

## Package checks

```bash
npm run check
node --import tsx scripts/evals.ts --suite offline-core
node --import tsx scripts/evals-scenario.ts
```

## Local substrate smoke

```bash
npm run benchmark:local
npm run benchmark:slop:smoke
```

These commands exercise the local Quest benchmark substrate. They are fast development checks, not official public benchmark runs.

## Terminal-Bench through Harbor

Preflight the local environment first:

```bash
npm run benchmark:tbench:preflight
```

Then run the official sample path:

```bash
npm run benchmark:tbench:sample
```

For the full official dataset:

```bash
npm run benchmark:tbench:full
```

To preview the Harbor invocation without running it:

```bash
node --import tsx benchmarks/harbor/run.ts --dataset terminal-bench-sample@2.0 --run-mode sample --dry-run
```

## SlopCodeBench local smoke

```bash
npm run benchmark:slop:local
```

This command validates Quest's checkpoint-aware adapter against local fixtures only. It is not the official public benchmark path.

## SlopCodeBench official runner overlay

Check out the official runner first, then execute one problem through the overlay:

```bash
npm run benchmark:slop:official -- --repo /tmp/slop-code-bench --problem <problem-id>
```

## Headless Quest directly

```bash
quest-headless run \
  --instruction "Plan and execute a small benchmark task" \
  --cwd "$(pwd)" \
  --json
```
