# Terminal-Bench Handoff (2026-04-10)

Historical handoff only. The current benchmark status source of truth is [`docs/internal/baseline-results.md`](./baseline-results.md).

## Scope

This pass stayed focused on `pi-quests` benchmark execution quality and Terminal-Bench substrate health:

- Harden Quest's benchmark execution path and failure surfacing.
- Add a Harbor integrity gate so structurally untrusted scores are not treated as valid.
- Recover the `qemu-startup` and `qemu-alpine-ssh` smoke helpers enough to isolate the remaining real blocker in code.

## What Changed

- `src/harbor-integrity.ts` and `src/harbor-runtime.ts`
  - Added a local Harbor integrity probe.
  - Fail closed when Harbor reuses a mutable agent/verifier environment and only restores `/tests`.
- `benchmarks/harbor/preflight.ts`
  - Added additive `summary` and `nextSteps` output.
  - Surfaced Harbor integrity results and clearer smoke diagnostics.
- `src/frontier-trials.ts`, `src/internal-headless.ts`, `src/profile-core.ts`, `src/workers.ts`, `src/quest-headless.ts`
  - Re-centered benchmark optimization on Quest-owned prompt/runtime behavior instead of Harbor-first engineering.
  - Added stronger benchmark completion discipline, failure categories, and clearer benchmark-facing summaries.
- `benchmarks/harbor/run.ts`
  - Restored bundling of both Linux Node runtimes so Harbor task containers can execute the Quest bundle correctly.
- `src/benchmark-helpers.ts`
  - Restored `qemu-startup` to the extracted-kernel/initramfs + serial + apkovl path that actually emits a login prompt on `ttyS0`.
  - Reworked `qemu-alpine-ssh` to use the same recovered boot baseline.
  - Provision SSH directly over the serial console instead of relying on the missing `dropbear` path.
  - Added per-command exit sentinels in the serial `expect` script so provisioning failures are not silently treated as success.
  - Extended the SSH readiness probe and changed `sshd` launch to include `UseDNS=no`.
- Tests
  - Updated benchmark adapter, helper, headless-core, frontier-trials, and worker-prompt coverage to lock in the new contracts.

## Verified

- Test suite:
  - `npm test -- --runInBand tests/benchmark-helpers.test.js`
  - Because of the package test script, this exercised the full suite and finished with 55 passing tests.
- Live Harbor smoke:
  - `qemu-startup` recovered successfully enough that Harbor smoke passed and only the Harbor integrity gate remained red.
  - For `qemu-alpine-ssh`, the live guest now:
    - reaches the serial login prompt
    - acquires DHCP on the QEMU user network
    - installs `openssh-server` and `openssh-sftp-server` from the Alpine ISO repository
    - starts `sshd`

## Latest Completed Harbor Artifact

- Latest completed `qemu-alpine-ssh` smoke artifact:
  - `/Users/mohamedmohamed/research/pi-quests/benchmarks/.runs/harbor/preflight-smoke/2026-04-10__16-04-06/qemu-alpine-ssh__u8FbIHE/result.json`

What that result means:

- Harbor still marked the run failed with `AgentTimeoutError` at the 900 second agent limit.
- `verifier_result.rewards.reward` was still `1.0`, which is another reason to keep treating Harbor scores as untrusted until the integrity gate is fixed.
- That completed run happened before the final `UseDNS=no` helper change was committed.

## Most Important Live Finding

The last vague blocker is gone. The remaining issue is narrow and concrete:

- Without `UseDNS=no`, the in-container probe could still fail with:
  - `Connection timed out during banner exchange`
- In the live Harbor task container, restarting `sshd` with `UseDNS=no` immediately fixed the problem:
  - `sshpass -p password123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 2222 root@localhost 'echo ready && uname -r'`
  - returned:
    - `ready`
    - `6.6.4-1-lts`

That live-proven fix is now baked into `src/benchmark-helpers.ts`.

## Exact Next Step

Run this first:

```bash
npm run internal:benchmark:tbench:preflight -- --smoke-task qemu-alpine-ssh
```

Expected outcome:

- `harbor-smoke.ok = true`
- `harbor-integrity.ok = false`

If that happens, the QEMU task-level blocker is cleared and the only remaining red light is Harbor trust.

## After That

If `qemu-alpine-ssh` smoke turns green on the rerun:

1. Keep Harbor as a thin substrate only.
2. Do not do more Harbor-first engineering unless it directly unblocks execution or score trust.
3. Continue Quest-hardness work on Terminal-Bench sample tasks.

## Files Most Relevant To Resume

- `/Users/mohamedmohamed/research/pi-quests/src/benchmark-helpers.ts`
- `/Users/mohamedmohamed/research/pi-quests/benchmarks/harbor/preflight.ts`
- `/Users/mohamedmohamed/research/pi-quests/src/workers.ts`
- `/Users/mohamedmohamed/research/pi-quests/src/internal-headless.ts`
- `/Users/mohamedmohamed/research/pi-quests/src/frontier-trials.ts`
- `/Users/mohamedmohamed/research/pi-quests/src/harbor-integrity.ts`
