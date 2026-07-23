# Overview

Status: Vision draft
Date: 2026-07-16

## Purpose

The new `scratch` API should maximize locally-verifiable correctness while preserving direct GPU control. It should add the constraints and checks that raw WebGPU lacks, without adding hidden behavior. It is a GPU execution kernel — compute and graphics are co-equal uses — not a geospatial scene graph and not a configuration DSL for every rendering technique.

`scratch` should make repeated low-level work easier:

- runtime and device lifecycle
- truthful resource identity, acknowledged allocation, logical BufferRegion/TextureViewSpec selection, replacement, readiness, content epochs, explicit transfers, and buffer host-mapping authority
- layout artifacts, layout codecs, and shader accessor generation
- acknowledged bind-layout construction and explicit BindSet preparation
- shader program composition and pipeline cache compatibility
- command readiness and resource dependency validation
- machine-readable diagnostics and validation reports
- submission recording, completion, and empty-work skipping

`scratch` should not own domain policy:

- map, globe, Cartesian, or mixed spatial semantics
- tile traversal, LoD, streaming, or eviction policy
- terrain, flow, vector, imagery, or point-cloud behavior
- layer history, reprojection, or camera-to-resource decisions

Those belong in `geo` or higher application layers.

## Design Axis

The objective above implies one axis for judging any abstraction: it should **add constraints and checks**, not **hidden behavior**. An abstraction may be more abstract than raw WebGPU and still be more verifiable, as long as behavior stays explicit and local. Raw WebGPU is the limit of minimal abstraction yet is the least verifiable surface: its validity rules are implicit and many logic errors fail silently with a wrong result instead of an error.

Two consequences:

- Keep the explicit, "verbose" surface — declared resource access, explicit transfer operations, explicit `BindLayout`, explicit submission order. Do not auto-infer it merely for brevity. Boilerplate an author writes and a validator checks is acceptable; ambiguity and hidden state are not.
- Every stateful "smart" feature (allocation versioning, content epochs, readiness, device-loss rehydration) must expose inspectable and assertable state. A feature that hides why a rebuild happened is net-negative.

## 0.x Breaking-Change Policy

GeoScratch is still in `0.x.x`. The new `scratch` API may break old APIs when doing so removes obsolete concepts or prevents the old model from constraining the kernel.

Existing APIs should be treated as:

- evidence of real use cases
- examples of ergonomics worth preserving when still valid
- references for migration tests
- warning signs where responsibilities were mixed

Existing APIs should not be treated as compatibility requirements until the project intentionally stabilizes a `1.x.x` contract.

## Core Boundary

The target model is:

```text
scratch = explicit GPU runtime + resources + layout codecs + transfers + bindings + programs + pipelines + commands + diagnostics + submission scheduler
geo     = spatial models + layer policy + geospatial resource loading and orchestration
```

The API should be explicit enough that unusual WebGPU workloads can still be expressed. Helpers may exist, but they must not hide the underlying resource, pipeline, pass, and command model.

`scratch` must not add a `Material` layer. A material-like abstraction couples shader program, data values, visual surface semantics, and object assignment. That belongs in `geo`, an application, or an optional scene helper. The scratch core keeps the split: `Program` declares shader code contracts, `BindSet` supplies concrete resources, `Pipeline` describes stable WebGPU executable state, and `Command` performs one explicit GPU action.

## Shape vs Time

Descriptors are useful for stable shape:

- buffer and texture usage
- shader modules and entry points
- bind layout entries
- pipeline static state
- pass attachment shape

Descriptors are weak for time-varying behavior:

- which commands run in the current submission
- which resources are ready
- which allocation version is bound
- which content epoch is read or written
- whether a pass is skipped
- whether a dirty resource is prepared
- whether command counts are static, dynamic, or indirect

Dynamic behavior should live in resource state, command state, and submission scheduling.
Buffer host mapping is also temporal authority rather than descriptor shape:
ordinary `createBuffer()` cannot carry `mappedAtCreation`; callers explicitly
use `createMappedBuffer()` or `mapBuffer()` and receive a bounded-lifetime
`MappedBufferLease`.

## Immediate Command Data

WGSL language features, pipeline immediate ranges, and command immediate values use
three separate contracts. `ScratchRuntime.wgslLanguageFeatures` is a frozen capability
snapshot. `Program.requiredLanguageFeatures` states what caller-authored WGSL needs.
Render and compute Pipelines declare `immediateSize`, while each Draw or Dispatch owns
one complete `CommandImmediateData` source.

The Command freezes source identity, not contents. Submission resolves readiness and
fallback first, then copies the current visible bytes once for every actual command
occurrence before any native effect. The private attempt snapshot feeds exactly one
full-range `setImmediates()` call. No preceding command state is inherited.

Immediate data is encoder input, not a Resource or transfer. It has no allocation
version, content epoch, resource-ledger entry, upload operation, or retained payload
history. This keeps four commonly confused mechanisms distinct: pipeline override
constants specialize pipeline creation; buffer uploads transfer Resource contents;
immediate data supplies per-command encoder bytes; render state supplies per-draw
rasterization state.

## Required Mental Model

The new API should make these boundaries hard to miss:

- `ScratchRuntime` owns GPU device state and caches.
- Covered native allocation is a Promise-returning GPU operation. A logical resource is installed only after validation, internal, and out-of-memory scopes plus lifecycle rechecks settle successfully.
- `Surface` owns presentation target configuration, not GPU execution.
- `Resource` owns logical identity, allocation lifecycle, and disposal. Only BufferResource and TextureResource own scalar content/readiness facts; SamplerResource owns none, and QuerySetResource owns indexed slot facts.
- `BufferRegion` and `TextureViewSpec` are synchronous immutable selection/interpretation values, not resources or native allocations.
- `MappedBufferLease` is zero-copy, exclusive host authority over one BufferRegion. READ release preserves the parent epoch; WRITE release advances it once. Pending or active mapping blocks actual Scratch GPU use without invalidating region construction, LayoutCodec work, or BindSet preparation.
- `QuerySetResource` is an indexed query-slot resource, not an unordered collection or shader binding.
- Transfer operations move data across CPU/GPU or GPU/GPU boundaries and advance content epochs explicitly.
- `LayoutCodec` is a preparation artifact that connects CPU packing, WGSL accessors, readback views, and layout diagnostics.
- `BindLayout` is a Promise-only acknowledged native binding ABI.
- `BindSet` freezes explicit BufferRegion/TextureViewSpec/SamplerResource bindings and is returned only after its initial native snapshot is prepared. Allocation replacement requires explicit `prepare()`; submission never repairs it.
- `Program` describes shader source, generated modules, entry points, and required layouts without owning concrete resources.
- `Pipeline` describes stable WebGPU executable state for a `Program` entry point. Public render and compute factories are Promise-only transactions and expose a wrapper only after native async creation, compilation evidence, supporting-object scopes, and lifecycle checks settle successfully.
- `Command` describes one executable GPU action.
- Draw and Dispatch may own complete per-command immediate data whose bytes are copied
  for each actual submission step without becoming Resource state.
- A Draw/Dispatch resource read declares either one exact numeric content epoch or `'current-at-step'`. The latter resolves once against explicit prior submission steps at the final selected command position, before that command's own writes; it does not reorder work or mutate the command.
- `ScratchDiagnostic` is the unified machine-readable validation contract; prose messages are not the stable API.
- `runtime.diagnostics` separates always-current facts, bounded recent operations, immutable incidents, and explicit temporary deep capture.
- GPU operation evidence uses schema v5 discriminated Resource, Pipeline, BindLayout, BindSet, Command, Readback, and Submission targets. Facts never borrow fields that do not belong to their object kind.
- `PassSpec` describes stable pass shape.
- `SubmissionBuilder` records commands into pass specs in explicit order.
- `SubmittedWork` is the inspectable handle returned by `.submit()`. Its native outcome and `done` boundary report observed submission, queue-completion, and lifecycle facts without waiting for readback mapping or host copy.
- `Frame` is not a scratch core type; frame cadence belongs to `geo`, applications, or presentation loops.
