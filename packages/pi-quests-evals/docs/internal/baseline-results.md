# Baseline Results

This is the maintained human-readable status document for Quest eval work.

## Current Default Eval Target

- Family: `frontierswe`
- Sample suite: `frontierswe-sample@v1`
- Full suite: `frontierswe@public-v1`
- Local regression suite: `local@core`

## What Is True Right Now

- Legacy external harness stacks are no longer supported in this repo.
- The optimizer now works only against eval families.
- The vendored FrontierSWE sample suite is the default maintainer path for fast local verification.
- Full FrontierSWE runs require an external `frontier-swe` checkout passed with `--repo`.

## Maintainer Commands

```bash
npm run internal:eval:local
npm run internal:eval:frontierswe:sample
npm run internal:eval:frontierswe:full -- --repo /path/to/frontier-swe
/quest evals prepare --eval frontierswe --suite frontierswe-sample@v1
/quest evals baseline --eval frontierswe --suite frontierswe-sample@v1
/quest evals run --eval frontierswe --suite frontierswe-sample@v1
```

## Optimizer Expectations

- Candidate `000` is the active baseline for the current eval suite.
- Interrupted or failed eval runs are materialized as `partial` or `failed` candidates.
- The frontier excludes incomplete candidates and recomputes only from canonical completed candidates.
- Pre-cutover artifacts outside `.pi/quests/evals/` are ignored by the runtime.
