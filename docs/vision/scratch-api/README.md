# Scratch API Redesign

Status: Vision draft
Date: 2026-06-30

This directory records the modular target design for the next `scratch` API. It expands the GPU-kernel direction described in `docs/vision/scratch-graphics-kernel.md` into smaller interface layers.

The documents here are design references, not implementation status. They should be read before changing `packages/geoscratch/src/gpu/`, `packages/geoscratch/src/scratch.js`, or the public `scratch` API shape.

## Module Map

- `00-overview/`: design principles, 0.x breaking-change policy, and API boundaries
- `01-runtime-surface/`: explicit async runtime and canvas surface separation
- `02-resources/`: logical resources, allocation versions, content epochs, readiness, and replacement
- `03-bindings/`: explicit bind layouts, bind sets, bind group cache, and shader inspection helpers
- `04-pipelines-commands/`: stable pipelines and executable GPU commands
- `05-passes-submissions-scheduler/`: persistent pass specs, submission builders, submitted work, and scheduler validation
- `06-design-review/`: review of `00`–`05` against AI-assisted authoring and general-purpose compute parity
- `07-transfers-epochs/`: submission-scoped transfers, allocation versions, content epochs, readback operation lifecycle, and indexed query-set transfer (resolves Gaps 2–4)

Each module has an English `README.md` and a Chinese `README_zh.md`.

## Confirmed Top-Level Decisions

- `scratch` is the GPU execution kernel (compute and graphics co-equal). `geo` owns scene, spatial, layer, tiling, loading, and geospatial policy.
- During `0.x.x`, breaking API redesign is allowed and expected when it removes obsolete concepts.
- Existing APIs are reference material, not compatibility constraints.
- The core API uses an explicit async `ScratchRuntime`. There is no implicit global device in the kernel contract.
- `Surface` is separate from `ScratchRuntime`; the runtime must support compute-only and offscreen workflows.
- Resources are logical handles with physical GPU allocation versions and content epochs.
- Resource missing/readiness policy must be declared by command or pass usage.
- CPU/GPU transfer is explicit: uploads, readbacks, and copies are commands or operations, not hidden `Resource` methods.
- `ReadbackOperation` has explicit lifecycle, retention, cancellation, disposal, budget, and diagnostic semantics.
- `QuerySetResource` keeps the WebGPU `QuerySet` name but means indexed query slots. Core query types are `timestamp | occlusion`; pipeline statistics are not a core query type.
- Bind layouts are explicit in the core API. Shader reflection is only a development helper or validator.
- `Command` is the canonical name for draw, dispatch, copy, upload, and related executable GPU actions.
- `PassSpec` is persistent pass shape. `SubmissionBuilder` binds pass specs to the current command list; `.submit()` returns `SubmittedWork`.
- The first scheduler model is explicit submission order plus dependency validation. Automatic sorting belongs in an optional upper orchestration layer.
- `Frame` is not a scratch core submission type. Frame cadence belongs to `geo`, applications, or presentation loops.
