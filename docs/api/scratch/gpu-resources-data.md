---
docId: scratch.gpu-resources-data
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/gpu/buffer-mapping.ts
  - packages/geoscratch/src/scratch/gpu/buffer.ts
  - packages/geoscratch/src/scratch/gpu/resource.ts
  - packages/geoscratch/src/scratch/gpu/sampler.ts
  - packages/geoscratch/src/scratch/gpu/texture.ts
---
# GPU Resources And Data

[简体中文](./gpu-resources-data_zh.md) | [Scratch overview](./README.md)

`Resource` gives GPU allocations stable logical identity, a runtime owner, disposal
state, `allocationVersion`, and `contentEpoch`. Allocation replacement and content
mutation are distinct facts: replacing native storage changes allocation identity;
successful writes advance content history. Commands can therefore reject stale views,
cross-runtime use, or unsatisfied read epochs before submission.

`BufferResource`, `BufferRegion`, `TextureResource`, `TextureViewSpec`, and
`SamplerResource` preserve native WebGPU descriptors while making ownership and
compatibility explicit. Buffer mapping uses `MappedBufferLease`; the lease is the
exclusive authority while host mapping is open and prevents conflicting GPU use.

Resources do not infer uploads, readbacks, schemas, or synchronization from arbitrary
JavaScript mutation. Layout interpretation, commands, and submission are separate.
Callers must dispose owned resources and must not retain native or view handles beyond
the logical authority that created them.
