# Overview

Status: Vision draft
Date: 2026-06-20

## Purpose

The new `scratch` API should reduce WebGPU boilerplate while preserving direct GPU control. It should be a graphics execution kernel, not a geospatial scene graph and not a configuration DSL for every rendering technique.

`scratch` should make repeated low-level work easier:

- runtime and device lifecycle
- resource identity, replacement, readiness, and dirty updates
- bind layout and bind group construction
- pipeline cache and compatibility
- command readiness and resource dependency validation
- frame submission and empty-work skipping

`scratch` should not own domain policy:

- map, globe, Cartesian, or mixed spatial semantics
- tile traversal, LoD, streaming, or eviction policy
- terrain, flow, vector, imagery, or point-cloud behavior
- layer history, reprojection, or camera-to-resource decisions

Those belong in `geo` or higher application layers.

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
scratch = explicit GPU runtime + resources + bindings + pipelines + commands + frame scheduler
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

- which commands run this frame
- which resources are ready
- which resource version is read or written
- whether a pass is skipped
- whether a dirty resource is prepared
- whether command counts are static, dynamic, or indirect

Dynamic behavior should live in resource state, command state, and frame scheduling.

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
- `Frame` records commands into pass specs in explicit order and submits them.
