# Overview

Status: Vision draft
Date: 2026-06-30

## Purpose

The new `scratch` API should maximize locally-verifiable correctness while preserving direct GPU control. It should add the constraints and checks that raw WebGPU lacks, without adding hidden behavior. It is a GPU execution kernel — compute and graphics are co-equal uses — not a geospatial scene graph and not a configuration DSL for every rendering technique.

`scratch` should make repeated low-level work easier:

- runtime and device lifecycle
- resource identity, replacement, readiness, and dirty updates
- bind layout and bind group construction
- pipeline cache and compatibility
- command readiness and resource dependency validation
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

- Keep the explicit, "verbose" surface — `resources.read/write`, explicit `BindLayout`, explicit submission order. Do not auto-infer it merely for brevity. Boilerplate an author writes and a validator checks is acceptable; ambiguity and hidden state are not.
- Every stateful "smart" feature (resource versioning, readiness, device-loss rehydration) must expose inspectable and assertable state. A feature that hides why a rebuild happened is net-negative.

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
scratch = explicit GPU runtime + resources + bindings + pipelines + commands + submission scheduler
geo     = spatial models + layer policy + geospatial resource loading and orchestration
```

The API should be explicit enough that unusual WebGPU workloads can still be expressed. Helpers may exist, but they must not hide the underlying resource, pipeline, pass, and command model.

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
- which resource version is read or written
- whether a pass is skipped
- whether a dirty resource is prepared
- whether command counts are static, dynamic, or indirect

Dynamic behavior should live in resource state, command state, and submission scheduling.

## Required Mental Model

The new API should make these boundaries hard to miss:

- `ScratchRuntime` owns GPU device state and caches.
- `Surface` owns presentation target configuration, not GPU execution.
- `Resource` is a logical handle with physical GPU object versions.
- `BindLayout` describes shader binding shape.
- `BindSet` binds concrete resources to a layout.
- `Pipeline` describes stable GPU program state.
- `Command` describes one executable GPU action.
- `PassSpec` describes stable pass shape.
- `Frame` is the presentation-optional submission builder. It records commands into pass specs in explicit order and submits them.
