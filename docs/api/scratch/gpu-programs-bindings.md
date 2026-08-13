---
docId: scratch.gpu-programs-bindings
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/gpu/binding.ts
  - packages/geoscratch/src/scratch/gpu/layout-artifact.ts
  - packages/geoscratch/src/scratch/gpu/layout-codec.ts
  - packages/geoscratch/src/scratch/gpu/pipeline-compilation.ts
  - packages/geoscratch/src/scratch/gpu/pipeline.ts
  - packages/geoscratch/src/scratch/gpu/program.ts
  - packages/geoscratch/src/scratch/gpu/shader-inspection.ts
  - packages/geoscratch/src/scratch/gpu/shader-module.ts
---
# Programs And Bindings

[简体中文](./gpu-programs-bindings_zh.md) | [Scratch overview](./README.md)

Programs, shader modules, layouts, bind sets, and pipelines are separate composition
units. `ShaderModule` owns source parts and compilation evidence. `Program` identifies
an entry point plus stage and declared buffer-layout requirements. Pipelines combine
programs with explicit native state and may be created asynchronously without
pretending that compilation completed synchronously.

`LayoutCodec` and immutable layout artifacts are the shared CPU/WGSL schema model.
They calculate alignment, size, runtime-array extent, pack/unpack values, emit WGSL
accessors, and distinguish schema compatibility from ABI compatibility. A buffer is
only storage; one allocation may be matched with different compatible views over time.

`BindLayout` describes slots and visibility. `BindSet` binds resources and must be
prepared against current allocation versions before execution. Preparation is an
idempotent realization step, not a global state machine and not permanent binding.
Shader inspection supplies conservative evidence and diagnostics; it does not replace
native WebGPU validation or accept source text as proof of runtime success.
