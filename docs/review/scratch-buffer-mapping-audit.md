# Scratch Buffer Host Mapping Audit

## Status

Implementation baseline frozen on 2026-07-23 from
`a2597ae150c794eac591aa2f754d15719300ac96`. This document starts as the
source-faithful contract and becomes the final parity audit during this goal.

## Normative Matrix

| Requirement | Official WebGPU fact | Scratch target | Initial state |
| --- | --- | --- | --- |
| Mapped creation | `mappedAtCreation` works without MAP usage | Dedicated acknowledged `createMappedBuffer()` | Missing |
| Creation alignment | Mapped-at-creation size is four-byte aligned | Local structured validation before native issue | Missing |
| Ordinary map usage | READ requires MAP_READ; WRITE requires MAP_WRITE | `mapBuffer({ region, mode })` preflight | Missing |
| Map range | Offset multiple of 8, size multiple of 4, in bounds | Validate `BufferRegion` before `mapAsync()` | Missing |
| Single mapping | Native buffer has at most one pending/active map | Module-private per-resource authority | Missing |
| GPU exclusion | Pending/mapped buffer is unavailable to queue work | All Scratch GPU-use paths fail before effects | Missing |
| Buffer barrier | `mapAsync()` waits for earlier use of that buffer | No broad `SubmittedWork.done` wait | Missing |
| Cancellation | `unmap()` rejects a pending map with AbortError | AbortSignal and lifecycle cancellation | Missing |
| View lifetime | `unmap()`/destroy/device destroy detaches views | Closed zero-copy `MappedBufferLease` | Missing |
| READ release | Host mutations are discarded | No content epoch change | Missing |
| WRITE release | Host mutations become buffer content | One ready content epoch | Missing |
| Uncertain WRITE | Native completion may become unknowable | One indeterminate epoch, no rollback | Missing |
| WGSL relation | Mapping does not alter shader memory layout | LayoutCodec/Program contracts unchanged | Preserved |
| Evidence | Native failures may settle asynchronously | Stable operations/incidents plus bounded current facts | Missing |

Official sources:

- https://gpuweb.github.io/gpuweb/#buffers
- https://gpuweb.github.io/gpuweb/#buffer-mapping
- https://gpuweb.github.io/gpuweb/#dom-gpubuffer-mapasync
- https://gpuweb.github.io/types/interfaces/GPUBuffer.html
- https://gpuweb.github.io/types/interfaces/GPUBufferDescriptor.html
- https://gpuweb.github.io/gpuweb/wgsl/

The checked Editor's Draft revision is
`99d2ded3335433260fd756abacc2d2b280999b8d`.

## Initial Native Call-Site Inventory

| Native operation | Current call site | Ownership classification | Target state |
| --- | --- | --- | --- |
| Scratch readback `mapAsync` | `packages/geoscratch/src/scratch/readback-mapping.ts` | Readback-private mapped staging | Retain unchanged |
| Scratch readback `getMappedRange` | `packages/geoscratch/src/scratch/readback.ts` | Readback-private owned-copy materialization | Retain unchanged |
| Scratch readback `unmap` | `packages/geoscratch/src/scratch/readback-staging.ts` | Readback-private cleanup | Retain unchanged |
| Descriptor `mappedAtCreation` forwarding | `packages/geoscratch/src/scratch/buffer.ts` | Public hidden mapped state | Remove from ordinary creation |
| Legacy `mapAsync/getMappedRange/unmap` | `packages/geoscratch/src/gpu/buffer/mapBuffer.js` | Non-Scratch legacy/raw module | Explicitly outside this goal |

The target inventory permits one additional Scratch-owned host-mapping module
to issue ordinary `mapAsync`, mapped-range access, and `unmap`. No example,
command, submission, or public wrapper may call those native methods directly.

## GPU-Use Inventory

The implementation audit must prove preflight coverage for:

- `UploadCommand.execute()` and submission buffer uploads;
- `ClearBufferCommand`;
- every `CopyCommand` direction containing a buffer;
- `ReadbackCommand` source copies;
- `ResolveQuerySetCommand` destinations;
- Draw vertex, index, indirect, declared, and bound buffers;
- Dispatch indirect, declared, and bound buffers; and
- selected readiness fallbacks without checking skipped commands.

Region construction, LayoutCodec host operations, BindSet description, and
BindSet preparation are deliberately not GPU-use boundaries.

## Evidence Plan

- Node fake-GPU contract and lifecycle tests;
- arbitrary map/error-scope settlement tests;
- source-level native call-site audit;
- deterministic stress runner;
- real headed-browser public-package proof;
- public TypeScript API checks;
- full `npm test`, `npm run typecheck`, and `npm run build`.

## Deferred Features

This audit does not claim `GPUExternalTexture`, RenderBundle, direct texture
readback, `ReadbackOperation.map()`, debug markers, shader-module
decomposition, `buffer_view`, broader LayoutCodec types, or complete
WebGPU/WGSL parity.
