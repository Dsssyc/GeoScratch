# ADR-134: Keep WebMercator Raster Source Metadata Outside Stable Sampling Pipelines

## Status

Accepted. Implementation proceeds through independently verified commits for CPU
preparation, native GPU sampling and resource replacement, then Flow Field integration.

## Context

The Flow diagnostic at `e0dd5f6` replayed one actual native frame. Replacing the
generated coverage scan with equivalent constant branches reduced its particle pass
from 4.145 ms to 2.869 ms; a 64-thread variant took 2.560 ms. Complete particle bytes
matched. This is evidence about the lookup implementation, not a promise that another
implementation has the same cost. The current loop already specializes coverage,
bounds and decoding into WGSL. Constant branches retain that source dependency.

## Decision

Geo prepares source interpretation as data. A fixed uniform ABI contains source
bounds, decoding parameters, 25 local level records, and a matrix-to-local-level map
for the built-in WebMercatorQuad range 0–24. Unsupported matrices have an explicit
sentinel. Each level retains its matrix id, compact page-table offset, tile bounds,
row width, texel bounds and exact wide-fixed half-texel registration. Lookup indexes
these records directly. Coordinate encoding and sampler/binding contracts remain
explicit pipeline compatibility boundaries. Source identity or interpretation data
alone must not change pipeline identity within the same compatible family.

`prepareWebMercatorVirtualRasterSampler` owns a private immutable CPU preparation and
returns fresh caller-owned upload bytes through `pack()`. LayoutCodec defines packing
and WGSL interpretation. Preparation has no GPU, residency, publication, camera,
cache or Worker responsibilities.

GPU composition owns its metadata allocation and borrows the matching Virtual Raster
page table and atlas. Bindings switch as a coherent set. Pending frames keep their
original metadata and raster owners alive until submitted work completes. A failed or
superseded replacement cannot partially install another interpretation. Publication
and acknowledgement retain their authority; no mutable global metadata buffer may
silently change the meaning of an older binding.

Uniform storage avoids increasing Flow's eight storage-buffer bindings. Capacity is
an ABI bound independent of source-supported levels. It does not expand the geographic
model or treat unresident pages as unsupported source levels.

Flow Field adopts metadata sampling as its normal composition. Constant-generated
sampling remains a reference for existing consumers and native parity tests; no
quality toggle selects sampler implementations. Frozen GPU cover, demand and terrain
files, Flow Layer, backend data, coordinate precision, logical footprint sampling and
temporal semantics remain outside this change. Scratch gains no geographic API.

## Verification

Required gates: sparse-level compact-index agreement; native cross-page/fallback,
status and decoding parity; A–B–A resource replacement with one native pipeline;
native failure and delayed-frame cleanup; actual particle replay with input restored
before every variant. Native DPR 2 compares the current loop, constant branches and
metadata implementation. Complete output and pipeline/resource counts accompany
timing. Sampling gains alone do not establish 144 Hz: presentation and serial frame
admission are separate subsequent changes.

## Sources

- [WGSL uniform layout constraints](https://www.w3.org/TR/WGSL/#address-space-layout-constraints), retrieved 2026-09-11.
- ADR-055/056: canonical positions, compact standard coverage and Geo-owned sampling.
- ADR-097/124: captured temporal ownership and explicit upload ordering.
- Local native diagnostic: `output/flow-field-gpu-deep-diagnosis-20260911/README.md`.

## Rollback

The pre-change reference is `e0dd5f6151fa8801ad8b3ea8480d40fdd3048401`.
Each verified phase has a separate commit. Revert dependent phases in reverse order.
There is no dataset migration, backend rebuild or irreversible format conversion.
