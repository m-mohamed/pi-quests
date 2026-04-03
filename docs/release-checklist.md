# Release Checklist

Use this checklist before tagging or publicly announcing a new Quest baseline.

## Package

- `npm run check`
- `npm pack --dry-run`
- verify `quest-headless --help` from an installed/tarball context
- verify the tarball does not include `.pi/`, benchmark residue, or local run
  outputs

## Docs

- README reflects the current command surface
- benchmark card reflects the current official benchmark targets and versions
- reproducibility guide matches the exact commands that were run
- verified baseline results are updated in `docs/baseline-results.md`
- press-release draft does not claim results that have not been reproduced

## Benchmarks

- Harbor preflight passes
- at least one official `terminal-bench-sample@2.0` run completes with no
  harness errors
- at least one official SlopCodeBench runner invocation completes with Quest
- benchmark artifacts include:
  - command used
  - model and thinking level
  - adapter version
  - profile id
  - result file paths
  - rerun date

## Release posture

- benchmark claims are based on official-run paths, not local smoke fixtures
- package is ready to publish, even if publication is intentionally deferred
- next improvement work is captured in `blueprints/changes/`
