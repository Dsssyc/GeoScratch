---
docId: scratch.worker
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/worker/diagnostics.ts
  - packages/geoscratch/src/scratch/worker/module-build.ts
  - packages/geoscratch/src/scratch/worker/module-catalog.ts
  - packages/geoscratch/src/scratch/worker/module.ts
  - packages/geoscratch/src/scratch/worker/task-phase-budget.ts
  - packages/geoscratch/src/scratch/worker/worker-system.ts
---
# Worker Execution

[简体中文](./worker_zh.md) | [Scratch overview](./README.md)

`WorkerSystem` is a domain-neutral CPU concurrency boundary. Applications create
bounded groups with explicit module allowlists, isolation, queue and active limits,
priority, idle reclamation, cancellation, and history. Tasks and retained contexts
have handles with observable state; disposal is explicit and does not share lifecycle
authority with `GPURuntime`.

Worker modules use one typed contract from source through deployment.
`defineWorkerModuleContract` gives stable identity, `defineWorkerModule` supplies
operations and optional stateful contexts, and `defineWorkerModuleBuild` registers
standalone artifacts. `WorkerModuleCatalog` resolves a generated manifest without a
Vite-specific URL convention. Transfer results make ownership movement explicit.

`TaskPhaseBudget` independently bounds scarce asynchronous phases such as fetch and
decode, preventing a large Worker count from multiplying network or decoder pressure.
Worker diagnostics preserve remote name, message, stack, task/module identity, and
cancellation kind. The system does not know tiles, DEM, cache, GPU upload, or business
operations; those are injected modules and application orchestration.
