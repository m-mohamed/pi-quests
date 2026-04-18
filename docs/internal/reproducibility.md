# Reproducibility

## Local Quest-Native Evals

```bash
npm run internal:eval:local
```

This runs the built-in suites from `src/evals-core.ts`.

## FrontierSWE Sample

```bash
npm run internal:eval:frontierswe:sample
```

This uses the vendored `frontierswe-sample@v1` task set under [`evals/frontierswe/sample-tasks`](../../evals/frontierswe/sample-tasks).

## FrontierSWE Full Corpus

```bash
npm run internal:eval:frontierswe:full -- --repo /path/to/frontier-swe
```

Use a local checkout of the upstream FrontierSWE repository for `frontierswe@public-v1`.

## Quest Headless Internal Eval Mode

```bash
PI_QUESTS_INTERNAL=1 node --import tsx src/quest-headless.ts run \
  --instruction "Finish the eval task" \
  --eval frontierswe \
  --suite frontierswe-sample@v1 \
  --task-id update-api-port \
  --run-mode sample \
  --json
```
