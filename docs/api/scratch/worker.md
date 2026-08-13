---
docId: scratch.worker
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/worker/context-pool.ts
  - packages/geoscratch/src/scratch/worker/diagnostics.ts
  - packages/geoscratch/src/scratch/worker/module-build.ts
  - packages/geoscratch/src/scratch/worker/module-catalog.ts
  - packages/geoscratch/src/scratch/worker/module.ts
  - packages/geoscratch/src/scratch/worker/task-phase-budget.ts
  - packages/geoscratch/src/scratch/worker/utilities.ts
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

`WorkerOperationProtocol`, `WorkerContextProtocol`, and `WorkerModuleProtocol` let a
contract declare operation input and output types before either caller or Worker
implementation exists. The same declaration checks `contract.implement(...)` and a
`WorkerContextPool.run(...)` call when the pool is parameterized by that operation
map. The protocol is a compile-time contract; runtime validation remains the
responsibility of a module at untrusted data boundaries.

`WorkerContextPool` owns one fixed group and its retained contexts. Its descriptor
must state whether the `WorkerSystem` is `borrowed` or `owned`; pool disposal always
releases the group and contexts and releases the system only in the owned case.
Initialization validates the entire context set before allocation and rolls back
partial resources. An idle pool gives each context's remote finalizer a bounded grace
period before group release. If work is queued or active, or a remote finalizer exceeds
that grace period, disposal gives convergence priority to group termination, so
non-cooperative application code cannot retain the lifecycle indefinitely. `inspect()`
exposes ownership, the configured grace period, and a disposal mode that distinguishes
remote finalization from forced convergence without returning raw context handles.

`TaskPhaseBudget` independently bounds scarce asynchronous phases such as fetch and
decode, preventing a large Worker count from multiplying network or decoder pressure.
Worker diagnostics preserve remote name, message, stack, task/module identity, and
cancellation kind. `recommendedWorkerCount` provides a bounded host-capacity default;
`workerRemoteErrorFacts` and `workerRemoteErrorCode` read application error facts only
from branded Worker diagnostics. The system does not know tiles, DEM, cache, GPU
upload, or business operations; those are injected modules and application
orchestration.

## Related decisions

- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-070-static-worker-module-artifacts.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
