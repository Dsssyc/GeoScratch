---
docId: scratch.lifetime
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/lifetime/index.ts
---
# Lifetime

[简体中文](./lifetime_zh.md) | [Scratch overview](./README.md)

`LifetimeScope` coordinates asynchronous cleanup for resources with mixed ownership.
Actions are registered with an explicit ownership mode and cleanup phase, then run in
deterministic reverse-registration order within each phase. Disposal is idempotent and
returns a report containing every failure rather than abandoning later cleanup.

The scope owns only actions registered as owned. Borrowed dependencies remain the
caller's responsibility. A stopped scope rejects new work, and snapshots expose state
without mutating it. This is a generic lifecycle primitive; it does not infer a graph,
cancel arbitrary application work, or make unrelated runtimes share authority.

Use one scope around an assembled subsystem when teardown spans Worker groups, GPU
objects, event listeners, and application resources. Keep the authority local: a
child may register cleanup with its owner, but should not silently dispose borrowed
parents.
