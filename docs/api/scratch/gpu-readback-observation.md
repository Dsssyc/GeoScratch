---
docId: scratch.gpu-readback-observation
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/gpu/readback-lease.ts
  - packages/geoscratch/src/scratch/gpu/readback-ownership.ts
  - packages/geoscratch/src/scratch/gpu/readback.ts
  - packages/geoscratch/src/scratch/gpu/texture-readback.ts
---
# Readback And Observation

[简体中文](./gpu-readback-observation_zh.md) | [Scratch overview](./README.md)

Readback is explicit GPU work followed by explicit host mapping. `ReadbackOperation`
records its source, byte layout, retention policy, mapping provenance, and lifecycle.
`ReadbackCommand` inserts the staging copy into submission order, so observation cannot
silently race preceding writes. Texture readback exposes origin, extent, row pitch, and
padding instead of pretending image rows are always tightly packed.

`MappedReadbackLease` owns the open mapped range. Bytes or typed values are available
only while the lease is valid unless the caller explicitly copies them. Retention
policy controls whether staging allocations are kept for reuse; it does not keep
logical source resources alive.

Readback never occurs implicitly during a getter and does not make GPU execution
synchronous. Epoch provenance lets callers verify which content was observed, while
native completion and mapping failure remain asynchronous and diagnostically visible.
