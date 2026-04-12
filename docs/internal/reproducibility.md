# Reproducibility

## Package checks

```bash
npm run check
node --import tsx scripts/evals.ts --suite offline-core
node --import tsx scripts/evals-scenario.ts
```

## Local headless substrate

```bash
npm run internal:benchmark:local
```

This command exercises the standalone local Quest benchmark substrate. It is a development check, not a frontier benchmark family.

## Terminal-Bench through Harbor

Inspect the trust gate directly:

```bash
npm run internal:benchmark:tbench:integrity
```

Preflight the local environment first:

```bash
npm run internal:benchmark:tbench:preflight
```

Then run the official sample path:

```bash
npm run internal:benchmark:tbench:sample
```

For the full official dataset:

```bash
npm run internal:benchmark:tbench:full
```

To preview the Harbor invocation without running it:

```bash
node --import tsx benchmarks/harbor/run.ts --dataset terminal-bench-sample@2.0 --run-mode sample --dry-run
```

## SlopCodeBench official runner overlay

Check out the official runner first, then execute one problem through the overlay:

```bash
npm run internal:benchmark:slop:official -- --repo /tmp/slop-code-bench --problem <problem-id>
```

## Headless Quest directly

```bash
quest-headless run \
  --instruction "Plan and execute a small benchmark task" \
  --cwd "$(pwd)" \
  --json
```
