# Quest Architecture Notes

`pi-quests` is the structured way to take on large, multi-feature coding work in Pi.

You describe the goal, collaborate on the plan, and Quest manages the work through bounded features, fresh workers, fresh validators, and repo-local state.

The useful takeaway from recent agent-architecture work is not the branding. It is the architecture discipline, translated into Quest terms.

## Distilled Ideas

The article makes five points that matter directly here:

1. Agents get worse as irrelevant context accumulates.
2. Implementers are biased reviewers of their own work.
3. The validation contract should be defined before feature decomposition.
4. Shared state should live in artifacts, not in one giant agent trajectory.
5. Validators should surface issues; orchestrators should turn those issues into targeted fix features.

That maps cleanly onto `pi-quests`:

- quest = the repo-local execution unit
- orchestrator = quest planner and fix-loop owner
- worker = single-feature implementer
- validator = fresh, read-only checker
- internal trials and evals = downstream measurement and tuning layer

## What We Adopted

### Quest work is the product

The primary loop is quest work inside Pi:

```bash
/quest new <goal>
/quest
/quest accept
```

Evals are downstream instrumentation for us. They help measure and tune the runtime, but they are not the community-facing product surface.

### Validation contract first

The orchestrator now treats `fulfills` entries as the quest contract and is instructed to finalize validation before the feature list. That keeps correctness criteria from collapsing into implementation bias.

In practice:

- write the proposal
- write validation assertions
- decompose features that explicitly claim those assertions
- validate each milestone with fresh agents
- convert validator findings into targeted fix features

### Workers implement, validators judge

Workers stay scoped to one feature. When the repo has a fitting test harness or validation command, they should add or update the narrowest failing proof before broader implementation. They do not self-approve.

Validators stay read-only. They do not patch code or suggest broad rewrites. Their job is to surface concrete issues that the orchestrator can convert into small corrective features.

### Externalized quest state

Quest state stays on disk under `.pi/quests/<quest-id>/`:

- `proposal.md`
- `validation-contract.md`
- `features.json`
- `validation-state.json`
- `services.yaml`
- shared skills and workflows

That is the point of the system: fresh agents can read the artifact they need for the job they have, instead of inheriting an overgrown trajectory.
Quest skill directories are also auto-discovered as Pi skill paths on startup and `/reload`, so reusable guidance written during a quest can feed later quest work without extra package wiring.

The control surface should stay Pi-native as well: use Pi commands, Pi widgets, Pi shortcuts, Pi working-message labels, Pi TUI components, and the injected Pi keybinding manager first, then keep Quest-specific code for orchestration semantics only.
Use the chain-safe runtime hooks the same way: `before_provider_request` for context-pressure visibility, `tool_result` for output-shape guidance, and `tool_call` mutation for quest-aware shell environment injection. Keep the always-on Quest and Trials status surfaces as single native widget components rather than separate text/action sidecars. Do not grab first-hit-wins shell hooks unless Quest truly needs to own them.

## Product Boundary

Use this repo in two layers:

1. Real quest work generates the real traces.
2. Internal trials and eval runs analyze those traces and tune prompt/runtime behavior.

Internal maintainer material lives under `docs/internal/`.

Do not invert that relationship. If eval harnesses start driving the public package surface, the system will optimize for the harness instead of the long-running coding loop it is supposed to improve.
