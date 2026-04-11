# Maintainer Loop

This file is maintainer-facing. It is not part of the public package story.

## Product order

The product is `pi-quests`, not the benchmark harness.

The order of operations is:

1. Use Quests for real repo work.
2. Capture quest artifacts and traces from that real usage.
3. Add internal evals and benchmark runs to measure the runtime honestly.
4. Tune prompt, runtime, and workflow behavior from those traces and evals.
5. Feed the improved runtime back into Quest work.

Do not invert this loop. If the benchmark becomes the product, the runtime will optimize for the harness instead of the long-running coding work it is supposed to improve.

## Internal assets

Internal-only surfaces in this repo exist to improve Quest:

- Trials and frontier search
- Harbor and benchmark adapters
- sample/full benchmark commands
- community trace mining
- scorecards and failure-category analysis

These are maintainer tools. They should stay repo-local, hidden from the community package surface, and subordinate to real Quest usage.

## Practical rule

Before adding any new public feature, ask:

- Does this make Quest work better?
- Does this help long-running autonomous coding directly?
- Would a community user need this on day one?

If the answer is no, keep it internal.

## Improvement inputs

The strongest improvement inputs are:

- real Quest traces from repo work
- mined community Pi traces that match Quest’s operating model
- targeted internal evals
- benchmark runs used as calibration, not as identity

That is the loop this repo should serve.
