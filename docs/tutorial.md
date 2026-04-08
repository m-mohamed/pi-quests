# Quest: From First Principles

## Table of Contents

1. [What is Pi?](#what-is-pi)
2. [How Does Pi Work?](#how-does-pi-work)
3. [How Do Pi Extensions Work?](#how-do-pi-extensions-work)
4. [What is Quest?](#what-is-quest)
5. [Our Primitives](#our-primitives)
6. [The Meta-Harness Optimization](#the-meta-harness-optimization)
7. [Harness Engineering](#harness-engineering)
8. [What Are We Trying to Accomplish?](#what-are-we-trying-to-accomplish)

---

## What is Pi?

Pi is a **long-running coding agent** built by badlogic (the creator of libgdx, Oculus, and more). It's a terminal-based AI coding assistant that:

- **Runs in your terminal** — It's a TUI (terminal user interface), not a GUI
- **Uses LLMs under the hood** — Currently supports OpenCode Go, OpenAI Codex, and many other providers
- **Persists sessions** — Your conversations, file edits, and context survive across terminal sessions
- **Has a rich extension system** — You can extend Pi with custom tools, commands, and handlers

Think of it as: **Cursor/Sonner/Claude CLI but terminal-native, with first-class extensibility.**

---

## How Does Pi Work?

### The Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Pi CLI                                │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │   TUI       │   │   Session   │   │    LLM      │       │
│  │  (display)  │◄──│  Manager    │◄──│   Client    │       │
│  └─────────────┘   └─────────────┘   └─────────────┘       │
│         │                 │                 ▲              │
│         ▼                 ▼                 │              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  Agent Core                         │   │
│  │  (message loop, tool execution, context management)│   │
│  └─────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │   read      │   │   bash      │   │    edit     │ ...  │
│  │   (tool)    │   │   (tool)    │   │   (tool)    │     │
│  └─────────────┘   └─────────────┘   └─────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Key Concepts

1. **Session** — A persisted conversation stored as JSONL. Contains all messages, tool calls, and model responses.

2. **Events** — Pi emits events during execution:
   - `session_start` — When a new session begins
   - `message_update` — When the model generates content
   - `tool_execution_start/end` — When tools run
   - `turn_end` — When a user/assistant turn completes

3. **Tools** — Functions the LLM can call. Built-in: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.

4. **Skills** — Prompt snippets that guide the model's behavior. Stored as `SKILL.md` files.

5. **Context Compaction** — When context gets too large, Pi summarizes old messages to fit within token limits.

---

## How Do Pi Extensions Work?

An extension is a TypeScript module that registers with Pi to:

1. **Add commands** — Slash commands like `/quest`, `/quests`
2. **Add tools** — Custom functions the LLM can call
3. **Add message renderers** — Custom display for message types
4. **Handle events** — React to session events
5. **Add UI widgets** — Display in the TUI header/footer

### Extension Skeleton

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export async function init(pi: ExtensionAPI) {
  // 1. Register a command
  pi.registerCommand("hello", {
    description: "Say hello",
    async execute(params, _signal, ctx) {
      return { content: [{ type: "text" as const, text: "Hello!" }] };
    }
  });

  // 2. Register a tool
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      // Tool logic
      return { content: [{ type: "text" as const, text: "Result" }] };
    }
  });

  // 3. Handle events
  pi.on("session_start", async (event, ctx) => {
    console.log("Session started:", event.id);
  });
}
```

### The Extension Context

When your extension runs, you get an `ExtensionContext` with:

- `ctx.cwd` — Current working directory
- `ctx.session` — The current session
- `ctx.sessionManager` — Manage sessions
- `ctx.ui` — TUI controls (setWidget, setStatus, notify)
- `ctx.modelRegistry` — Access models
- `ctx.signal` — Cancellation signal

---

## What is Quest?

Quest is our Pi extension that implements **autonomous long-running coding** with **optimization**.

### The Problem

- Pi is great at single-turn interactions
- But for multi-day projects, you need structure
- Running on benchmarks (Terminal-Bench, SlopCodeBench) shows gaps in agent behavior

### The Solution

Quest provides:

1. **Quest State Machine** — Planning → Proposal → Running → Completed/Blocked/Aborted
2. **Milestones & Features** — Break work into chunks
3. **Validation** — Assertions and readiness checks
4. **Trials System** — Run experiments to improve the agent profile
5. **Meta-Harness Optimization** — Iteratively improve the profile based on results

---

## Our Primitives

### 1. QuestState

```typescript
interface QuestState {
  id: string;           // Unique quest ID
  title: string;        // Human-readable title
  goal: string;        // What we're trying to achieve
  status: QuestStatus;  // planning | proposal_ready | running | paused | blocked | completed | aborted
  plan?: QuestPlan;     // Milestones and features
}
```

### 2. QuestProfile

Configuration for how Quest behaves:

```typescript
interface QuestProfile {
  id: string;
  promptSurfaces: QuestPromptSurfaces;  // Different prompts for different roles
  toolAllowlist: QuestRoleToolPolicy;   // What tools each role can use
  ensemblePolicy: QuestModelEnsemblePolicy;  // Which models to use when
  harnessPolicy: QuestHarnessPolicy;    // Quality control settings
}
```

### 3. QuestTraceBundle

A record of what happened during a run:

```typescript
interface QuestTraceBundle {
  id: string;
  role: QuestRole;      // orchestrator | worker | validator | trial | proposer
  ok: boolean;         // Did it succeed?
  toolTimeline: QuestTraceToolEvent[];
  tags: QuestFailureTag[];  // What went wrong (if anything)
  diagnostics: QuestDiagnostic[];  // Info/warnings/errors
  compactionEvents: Array<{...}>;  // Context compactions
}
```

### 4. PiSessionTrace

Raw Pi session data (NOT converted to QuestTraceBundle):

```typescript
interface PiSessionTrace {
  id: string;
  events: PiSessionEvent[];  // Full event stream
  modelChanges: Array<{...}>;
  compactions: Array<{...}>;
  derivedTags: QuestFailureTag[];  // Derived from conversation patterns
}
```

### 5. QuestFailureTag

Why a run failed:

- `prerequisite_miss` — Missing required info
- `weak_validation` — Validation didn't catch issues
- `blocked_milestone` — Stuck on a milestone
- `repeated_corrective_loop` — Trying same thing over and over
- `operator_abort` — User stopped it
- `context_overflow` — Context got too big
- `model_mismatch_suspected` — Wrong model for task
- `tool_heavy` — Too many tool calls
- `validator_failure` — Validator had issues
- `worker_failure` — Worker had issues

---

## The Meta-Harness Optimization

Based on the [Meta-Harness paper](https://arxiv.org/abs/2603.28052) from Stanford.

### The Core Insight

> **Full trace access (10M tokens) beats compressed approaches (26K tokens) by 10-49 points.**

### How It Works

1. **Search Set** — 70% of benchmark tasks used for optimization
2. **Hold-out Set** — 30% kept separate for final validation
3. **Candidates** — Each profile variant gets a directory
4. **Proposer** — An agent that reads all prior candidates and proposes improvements

### Our Implementation

```
.pi/quests/meta-harness/
├── current/profile.json       # Active profile
├── candidates/001/             # Each candidate gets a directory
│   ├── profile.patch.json    # The proposed change
│   ├── scores.json           # Search/hold-out scores
│   └── traces/                # Saved traces
├── search-set.json            # 7 tasks (70%)
├── hold-out-set.json           # 3 tasks (30%)
└── traces/community/          # 723 community traces
```

### The Loop

```
1. Run search set with current profile → candidate 000
2. Proposer reads all candidates + community traces
3. Proposer proposes a patch to fix failure tags
4. Apply patch, run search set again
5. If search improves AND hold-out doesn't regress → archive
6. Repeat 5 times
```

### Why This Works

- **Non-Markovian** — Proposer can look at ANY prior candidate
- **Counterfactual** — Can trace failure back to specific design decision
- **Pareto Frontier** — Multi-objective (accuracy vs cost vs speed)

---

## Harness Engineering

Based on Martin Fowler's [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html).

### The Core Idea

A **harness** guides and observes agent behavior:

- **Feedforward (guides)** — Anticipate and steer BEFORE acting
- **Feedback (sensors)** — Observe AFTER acting, enable self-correction

### Two Types of Guides

1. **Computational** — Deterministic, cheap
   - Linters, type checkers, test runners
   - Architectural constraint rules

2. **Inferential** — Semantic, expensive
   - Code review agents
   - Quality judges

### Our Implementation

```typescript
interface QuestHarnessPolicy {
  computationalGuides: {
    enabled: boolean;
    linterConfigs: string[];
    archConstraints: string[];
  };
  inferentialGuides: {
    enabled: boolean;
    codeReviewAgents: string[];
  };
  sensors: {
    computational: { linters: string[]; typeCheckers: string[]; };
    inferential: { codeReviewAgents: string[]; qualityJudges: string[]; };
  };
  fitnessFunctions: {
    enabled: boolean;
    performanceRequirements: Array<{metric: string; threshold: number}>;
  };
}
```

### Ashby's Law

> The regulator must have at least as much variety as the system it governs.

We implement this through:
- Structured prompt surfaces (reduces search space)
- Tool allowlists (constrains action space)
- Validation assertions (detects failures)

---

## What Are We Trying to Accomplish?

### Primary Goal

**Improve Quest's performance on Terminal-Bench and SlopCodeBench** through iterative optimization.

### Success Metrics

1. **Accuracy** — Percentage of tasks solved
2. **Cost** — Total LLM spend
3. **Duration** — Time to completion

### The Current State

| Component | Status |
|-----------|--------|
| Pi-native trace parsing | ✅ Working (parsePiSession) |
| Community traces | ✅ 723 sessions analyzed |
| Meta-harness filesystem | ✅ Implemented |
| Proposer agent | ✅ Can read candidates, community stats |
| Harness policy | ✅ Computational/inferential guides |
| Model routing | ✅ OpenCode Go / Codex models |
| Evaluation pipeline | ⚠️ Needs benchmark credits |

### What's Missing (Needs Credits)

1. Run Terminal-Bench search set → candidate 000 baseline
2. Run 5 iterations of propose → score → validate → archive
3. Compute Pareto frontier

---

## Quick Reference

### Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry point, tool/command registration |
| `src/types.ts` | Quest type definitions |
| `src/state-core.ts` | Quest state management |
| `src/plan-core.ts` | Plan parsing and validation |
| `src/workers.ts` | Worker/validator subprocess execution |
| `src/trials-core.ts` | Trials meta-harness (profiles, traces, experiments) |
| `src/trials-runtime.ts` | Trials execution loop |
| `src/telemetry-core.ts` | Live run snapshots |
| `src/ui-core.ts` | Pi-native TUI widgets |
| `src/workflows.ts` | Learned workflow extraction |
| `src/utils.ts` | Shared utilities (compact, unique, truncate) |

### Commands

| Command | What It Does |
|---------|--------------|
| `/quest new <goal>` | Create new quest |
| `/quest accept` | Accept proposal and start |
| `/quest pause` | Pause running quest |
| `/quest resume` | Resume paused quest |
| `/quests` | List all quests |
| `/quest trials` | Run trials optimization |

### Models

| Model | Provider | Use Case |
|-------|----------|----------|
| glm-5.1 | zai | All roles (worker, validator, orchestrator) |

---

## Next Steps

1. **Get benchmark credits** — Run Phase 3/4 to get baseline
2. **Run optimization** — 5 iterations of propose → score → validate
3. **Analyze results** — See which patches improve performance
4. **Document findings** — Update baseline-results.md