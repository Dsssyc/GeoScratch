# Submission And Readback

Status: Vision draft
Date: 2026-06-30

## Decision

`Frame` is the submission unit, and presentation is optional. Compute results return to the CPU through the resource itself — a `BufferResource` is its own readback handle — read with an explicit `await`. This resolves Gaps 2–4 recorded in `06-design-review` and makes general-purpose compute a first-class, testable use.

## Frame Is The Submission Unit

`Frame` records passes and commands and submits them. Presentation is one mode, not the definition:

- with a surface output → a presentation frame (current-frame texture, skip-empty-for-present)
- with no surface → a compute or offscreen submission

`submit()` is awaitable for GPU completion, backed by `queue.onSubmittedWorkDone`. Completion is separate from data readback: awaiting `submit()` tells you the work finished; it does not move data to the CPU.

```ts
const f = scratch.frame()              // no surface → compute submission
    .compute(simulationPass, [simulate])

await f.submit()                       // resolves when the GPU finishes this submission
```

A presentation frame is the same builder with a surface output. `Frame` is therefore the single submission concept; there is no separate `Submission` or `Batch` type.

## Readback: The Resource Is The Handle

A `BufferResource` is its own readback handle, and the buffer's layout (see `02-resources`) decides the view. There is no required separate result type for the common path:

```ts
// homogeneous buffer or contiguous segment → a TypedArray
const data = await particles.toArray()
const segs = await packed.segment('flags').toArray()    // Int8Array

// struct (AoS) or heterogeneous → ArrayBuffer + layout-derived ArrayBufferViews
const bytes = await particles.toBytes()                 // owned copy
particles.at(i)                                         // decoded struct (DataView-backed)
particles.field('pos')                                  // strided field
```

Properties:

- **The layout decides the view.** Readback mirrors the buffer's segments (`02-resources`): a scalar segment (or single-segment scalar buffer) maps to a `TypedArray`; a struct segment maps to an `ArrayBuffer` plus layout-derived `ArrayBufferView`s. AoS fields are strided, so they are read through a `DataView` (or deinterleaved into a contiguous copy), not one fixed typed array. The same declared layout drives both this CPU view and the GPU-side interpretation.
- **Provenance, not manual ordering.** A readback waits on the submission that produced the buffer version captured by the readback request. `02-resources` already tracks version, readiness, and the last writer, so the runtime knows what to wait for. Reading a buffer that was never written reports an unready resource instead of returning garbage.
- **Explicit `await`.** This is the one deliberate divergence from Taichi, whose host access (`field.to_numpy()`, `field[i]`) hides the GPU sync behind a getter. A hidden sync is a stall footgun inside a frame budget, so the cost stays visible as an `await`.
- **Auto staging.** The runtime owns the `MAP_READ` staging copy; a buffer does not declare map usage for the common path. It does need `copySrc`. `toBytes()` / `toArray()` return an owned copy by default; a zero-copy mapped view is an advanced escape hatch, since the mapped range is invalidated on unmap.

## Latency Model

The handle covers both ends of the latency spectrum with no extra types:

- **Immediate** — `await buffer.toArray()` right after `submit()`. Deterministic; stalls until the GPU finishes and the map completes. This is the path that makes a compute kernel testable from the CPU.
- **Pipelined** — start a readback request after the producing submission and await it later. A latency-tolerant streaming helper (a ring of readbacks) can be built on top without changing this model.

`ReadbackCommand` exists only as an escape hatch for the rare ordered-staging case: explicitly placing the GPU copy/resolve point inside the validated command graph, then awaiting the result after submission. It is not the default path.

## Lifetime And Leaks

- The staging behind a readback is runtime-owned and freed when the read resolves or when the resource is disposed.
- A readback requested but never consumed leaves a detectable pending readback operation. Development validation should warn on stale pending readbacks, so a leak is visible rather than silent.

## Timing And Queries (Gap 4)

GPU timing reuses the readback path instead of inventing a parallel mechanism:

- `QuerySetResource` is a resource kind for timestamp or occlusion queries (feature-gated where required). Pipeline statistics are not part of the current WebGPU core contract and should stay outside the core design unless a future target explicitly supports them.
- `timestampWrites` attach to pass specs (`pass.render({ ..., timestampWrites })`, `pass.compute({ ..., timestampWrites })`).
- Results resolve through the same handle: `await querySet.toArray()` (or resolve into a buffer, then `toArray()`).

## Non-Goals

- Do not hide the GPU sync. Host access is an explicit `await`, never a transparent stall.
- Do not add a Taichi-style kernel DSL. WGSL stays explicit; any auto-parallel authoring layer belongs above `scratch`, not in the kernel.
- Do not make `ReadbackCommand` the default. The resource handle is the default; the command is the ordered-staging escape hatch.
- Do not require buffers to declare map usage for the common readback path; the runtime stages.
- Do not introduce a separate `Submission` or `Batch` type. `Frame` is the submission unit.
