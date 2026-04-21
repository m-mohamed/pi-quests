# `pi-quests` Workspace

This repo is now a workspace, not the published package.

Packages:

- `packages/pi-quests-core`: shared quest-only runtime library
- `packages/pi-quests`: public Pi package
- `packages/pi-quests-evals`: private maintainer eval and optimizer package

Install the public package locally:

```bash
pi install /Users/mohamedmohamed/research/pi-quests/packages/pi-quests
```

Install the private maintainer eval package locally:

```bash
pi install /Users/mohamedmohamed/research/pi-quests/packages/pi-quests-evals
```

Useful workspace commands:

```bash
npm run check
npm run internal:eval:local
npm run internal:eval:frontierswe:sample
```

Package docs:

- public Quest docs: [`packages/pi-quests/README.md`](./packages/pi-quests/README.md)
- public architecture notes: [`packages/pi-quests/docs/quest-architecture.md`](./packages/pi-quests/docs/quest-architecture.md)
- internal eval docs: [`packages/pi-quests-evals/docs/internal/README.md`](./packages/pi-quests-evals/docs/internal/README.md)
