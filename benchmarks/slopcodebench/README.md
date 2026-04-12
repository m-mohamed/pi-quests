# SlopCodeBench Integration

This directory contains the official-run overlay for a local checkout of the upstream SlopCodeBench runner.

Official runner path:

```bash
npm run internal:benchmark:slop:official -- --repo /tmp/slop-code-bench --problem <problem-id>
```

The official path uses `benchmarks/slopcodebench/official-overlay/` to register Quest with the upstream `slop-code run` CLI without patching the upstream repo.

In the frontier runtime, SlopCodeBench is discovered from the upstream `problems/*/config.yaml` manifest, split deterministically into search and hold-out sets, and archived under the same `.pi/quests/trials/` candidate layout used by Terminal-Bench.
