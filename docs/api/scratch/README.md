---
docId: scratch
canonical: true
apiSources:
---
# Scratch

[简体中文](./README_zh.md) | [API root](../README.md) | [Generated reference](../reference/scratch.md)

Scratch is the domain-neutral foundation in `geoscratch/scratch`. It exposes
explicit objects rather than hidden global state: callers own runtimes, resources,
submissions, caches, Worker systems, and their disposal. Scratch expresses native
WebGPU capability while adding stable identity, ownership, lifecycle authority,
validation, diagnostics, and inspectable history.

## Subsystems

- [Diagnostics](./diagnostics.md)
- [Lifetime](./lifetime.md)
- [Persistent cache](./cache.md)
- [Geometry](./geometry.md)
- [GPU runtime and surfaces](./gpu-runtime-surface.md)
- [GPU resources and data](./gpu-resources-data.md)
- [Programs and bindings](./gpu-programs-bindings.md)
- [Commands and submissions](./gpu-commands-submissions.md)
- [Readback and observation](./gpu-readback-observation.md)
- [Worker execution](./worker.md)

Scratch does not define maps, coordinate reference systems, tile selection, raster
residency policy, terrain, scenes, or layers. Those belong to Geo or applications.
An example-specific workflow is evidence for a missing primitive, not a core API
shape by itself.
