# SlopCodeBench Integration

This directory contains two integration paths:

1. a local Quest-owned smoke adapter for fast development checks
2. an official-run overlay for a local checkout of the upstream SlopCodeBench runner

The local smoke adapter maps SlopCodeBench's base-spec plus checkpoint structure onto bounded Quest runs. Each checkpoint becomes one headless Quest invocation with:

- benchmark provenance set to `slopcodebench`
- the problem id mapped to `taskId`
- the checkpoint id mapped to `checkpointId`
- replay traces captured back into Trials

Local development commands:

```bash
npm run benchmark:slop:smoke
npm run benchmark:slop:local
```

These local datasets are smoke fixtures for the Quest adapter. They are not the official public SlopCodeBench tasks.

Official runner path:

```bash
npm run benchmark:slop:official -- --repo /tmp/slop-code-bench --problem <problem-id>
```

The official path uses `benchmarks/slopcodebench/official-overlay/` to register Quest with the upstream `slop-code run` CLI without patching the upstream repo. Public benchmark claims should only use results from that official runner path.
