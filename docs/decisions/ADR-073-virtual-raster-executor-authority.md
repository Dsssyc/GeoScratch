# ADR-073: Make Virtual Raster Executor Authority Explicit

## Status

Accepted

## Date

2026-08-14

## Context

`VirtualRasterRuntime` composes demand scheduling, CPU residency, GPU publication,
and feedback, but its descriptor previously accepted one bare
`VirtualRasterRequestExecutor`. The runtime borrowed that executor without expressing
the borrowing in its type or facts. The DEM adapter consequently created the Worker
executor, passed it into Geo, and then implemented a second initialization rollback,
idempotent disposal promise, ordered shutdown, and failure aggregation around the
generic runtime.

That arrangement had two problems. A caller or agent could not determine executor
ownership from the runtime descriptor, and every source adapter wanting singular
lifecycle authority had to repeat the same cleanup mechanics. Moving DEM, HTTP, PNG,
COG, cache policy, or WorkerSystem construction into Geo would solve the repetition by
creating an example-shaped abstraction and is not acceptable.

## Decision

`VirtualRasterRuntimeDescriptor.executor` is a required discriminated binding:

```ts
type VirtualRasterExecutorBinding =
    | {
        ownership: 'borrowed'
        executor: VirtualRasterRequestExecutor
    }
    | {
        ownership: 'owned'
        executor: VirtualRasterRequestExecutor & {
            dispose(): Promise<void>
        }
    }
```

There is no implicit bare-executor form and no default ownership. A borrowed executor
is never disposed or otherwise lifecycle-managed by the runtime. An owned executor's
authority transfers to the factory when creation begins. If validation or allocation
fails after accepting the binding, the factory releases every authority it created
and disposes the owned executor. Borrowed executors remain untouched on the same
failure path.

Runtime disposal remains idempotent and ordered:

```text
stop and settle request scheduler
    -> abandon any active publication
    -> dispose demand controller, residency, and GPU state
    -> dispose the owned executor exactly once
```

Cleanup continues after an independent failure. Multiple failures are returned as one
`AggregateError` containing the original errors; the implementation does not replace
them with prose-only summaries. Runtime facts report `executorOwnership` but do not
copy or fabricate Worker, cache, network, or decoder facts. An executor remains the
authority for its own inspectable business and lifecycle state.

The binding controls only the supplied executor. It does not make Geo own an
application cache, a separately shared `WorkerSystem`, camera state, network format,
or source-specific policy. An executor that internally borrows a WorkerSystem retains
that independent authority contract.

## Consequences

- Runtime construction and disposal expose one machine-readable ownership decision.
- Source adapters can transfer an executor to Geo without repeating generic rollback
  and shutdown code.
- Shared executors remain possible through explicit borrowing.
- DEM, COG, PNG, HTTP, cache budgets, and Worker module selection remain application
  source-adapter responsibilities.
- Existing callers must choose owned or borrowed authority; no compatibility overload
  retains the ambiguous descriptor.

## Rejected Alternatives

### Always own the executor

Rejected because multiple fields or runtimes may intentionally share one independently
managed executor.

### Always borrow and keep application cleanup wrappers

Rejected because it preserves ambiguous ownership and forces every singular source
runtime to reimplement the same failure and disposal protocol.

### Make Virtual Raster create Worker and Cache authorities

Rejected because request executors may use network, files, simulation, editing,
procedural generation, a shared WorkerSystem, or no Worker at all. Geo owns the
request-execution boundary, not one transport implementation.
