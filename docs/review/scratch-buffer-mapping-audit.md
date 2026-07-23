# Scratch Buffer Host Mapping Audit

## Status

Implementation baseline was frozen on 2026-07-23 from
`a2597ae150c794eac591aa2f754d15719300ac96`. Buffer host mapping V1 is now
implemented on `socu/scratch-buffer-mapping-v1`; this document is the
source-faithful final capability audit. Independent review and the complete
post-review acceptance rerun remain separate termination gates.

## Normative Matrix

| Requirement | Official WebGPU fact | Scratch result | Status |
| --- | --- | --- | --- |
| Mapped creation | `mappedAtCreation` works without MAP usage | Dedicated acknowledged `createMappedBuffer()` returns a whole-buffer WRITE lease | Complete |
| Creation alignment | Mapped-at-creation size is four-byte aligned | Local structured validation before native issue | Complete |
| Ordinary map usage | READ requires MAP_READ; WRITE requires MAP_WRITE | `mapBuffer({ region, mode })` preflight | Complete |
| Map range | Offset multiple of 8, size multiple of 4, in bounds | `BufferRegion` is validated before `mapAsync()` | Complete |
| Single mapping | Native buffer has at most one pending/active map | Module-private per-resource O(1) authority | Complete |
| GPU exclusion | Pending/mapped buffer is unavailable to queue work | Direct and resolved-submission paths fail before effects | Complete |
| Buffer barrier | `mapAsync()` waits for earlier use of that buffer | No broad `SubmittedWork.done` wait | Complete |
| Cancellation | `unmap()` rejects a pending map | AbortSignal and lifecycle cancellation clean up once | Complete |
| View lifetime | `unmap()`/destroy/device destroy detaches views | Closed zero-copy `MappedBufferLease` | Complete |
| READ release | Host mutations are discarded | No content epoch change | Complete |
| WRITE release | Host mutations become buffer content | Exactly one ready content epoch | Complete |
| Uncertain WRITE | Native completion may become unknowable | One indeterminate epoch, no rollback | Complete |
| WGSL relation | Mapping does not alter shader memory layout | LayoutCodec/Program contracts unchanged | Preserved |
| Evidence | Native failures may settle asynchronously | Stable operations/incidents plus bounded current facts | Complete |

Official sources:

- https://gpuweb.github.io/gpuweb/#buffers
- https://gpuweb.github.io/gpuweb/#buffer-mapping
- https://gpuweb.github.io/gpuweb/#dom-gpubuffer-mapasync
- https://gpuweb.github.io/types/interfaces/GPUBuffer.html
- https://gpuweb.github.io/types/interfaces/GPUBufferDescriptor.html
- https://gpuweb.github.io/gpuweb/wgsl/

The checked Editor's Draft revision is
`99d2ded3335433260fd756abacc2d2b280999b8d`.

## Final Native Call-Site Inventory

| Native operation | Current call site | Ownership classification | Result |
| --- | --- | --- | --- |
| General `mapAsync` | `packages/geoscratch/src/scratch/buffer-mapping.ts:849` | Mapping transaction boundary | Approved |
| Mapped-creation `getMappedRange` | `packages/geoscratch/src/scratch/buffer-mapping.ts:239` | Whole-buffer WRITE lease | Approved |
| Ordinary `getMappedRange` | `packages/geoscratch/src/scratch/buffer-mapping.ts:387` | Selected-region lease | Approved |
| General `unmap` | `packages/geoscratch/src/scratch/buffer-mapping.ts:668` | Single cleanup owner | Approved |
| Readback `mapAsync` | `packages/geoscratch/src/scratch/readback-mapping.ts:255` | Readback-private mapped staging | Retained |
| Readback `getMappedRange` | `packages/geoscratch/src/scratch/readback.ts:542` | Readback-private owned-copy materialization | Retained |
| Readback `unmap` | `packages/geoscratch/src/scratch/readback-staging.ts:199`, `:237` | Readback-private cleanup | Retained |
| Dedicated `mappedAtCreation` lowering | `packages/geoscratch/src/scratch/buffer-mapping.ts`, `packages/geoscratch/src/scratch/buffer.ts` | Internal mapped factory only | Approved |
| Ordinary descriptor guard | `packages/geoscratch/src/scratch/buffer.ts:685` | Reject even `mappedAtCreation: false` | Complete |
| Legacy `mapAsync/getMappedRange/unmap` | `packages/geoscratch/src/gpu/buffer/mapBuffer.js` | Non-Scratch legacy/raw module | Explicitly outside Scratch authority |

`tests/audits/scratch-buffer-mapping-parity.mjs` parses JavaScript and
TypeScript call expressions with the TypeScript AST. It currently finds
exactly the approved 11 native map/range/unmap calls above and none in
examples. Error-message prose and generated Vite dependencies are not counted.

## GPU-Use Inventory

| GPU-use boundary | Enforcement | Status |
| --- | --- | --- |
| Direct and submitted buffer upload | Validation and queue replay both call the common buffer-use preflight | Complete |
| Clear, all four copy directions, ordered readback, and query resolve | Each direct encoder boundary calls the common preflight | Complete |
| Direct ReadbackOperation | Source authority is checked before staging allocation or encoder creation | Complete |
| Draw vertex/index/indirect/bound/declared buffers | Construction proves complete declarations; direct encode and selected submission command preflight those declarations | Complete |
| Dispatch indirect/bound/declared buffers | Same closed declaration and execution boundary | Complete |
| Readiness fallback | Only the resolved selected command is checked; skipped commands/passes cause no false conflict | Complete |
| Whole submission attempt | Resolved plan is preflighted before immediate snapshots, Surface preparation, encoder creation, readback claims, or queue actions | Complete |

Region construction, LayoutCodec host operations, BindSet description, and
BindSet preparation are deliberately not GPU-use boundaries.

## Recorded Evidence

- 22 focused fake-GPU tests cover mapped creation, ordinary READ/WRITE,
  preflight timing, authority conflict, AbortSignal, arbitrary map/scope
  settlement order, validation/internal/OOM/native failure, lifecycle races,
  cleanup uncertainty, epoch behavior, and anti-forgery.
- Public TypeScript checks prove the new exports and reject ordinary
  `mappedAtCreation`.
- Static parity audit passes every public/export/preflight/native-call/bounded
  evidence check.
- Stress evidence completed 20,000 ordinary leases and 5,000 mapped creations.
  Every view detached; current mappings, selected bytes, live resources, and
  lifecycle subscribers ended at zero. Each operation recorder retained 64
  entries and serialized evidence stayed below 64 KiB.
- Headed Chrome 150 on Apple Metal 3 passed the public-package example and
  direct probe on the first attempt. Values were `3,5,8,13`; READ and WRITE
  views detached; READ epoch stayed 0; WRITE epoch became 1; conflict,
  GPU-use exclusion, and abort returned their stable diagnostic codes; console,
  page, request, and uncaptured-GPU-error lists were empty.
- The final complete `npm test`, `npm run typecheck`, and `npm run build`
  rerun occurs after the single independent review; the evidence above does
  not substitute for that gate.

## Schema V5 Audit

The extension remains compatible schema v5. `buffer-mapping` and
`buffer-mapping-failure` are additive discriminators using the existing
BufferResource target. Snapshots add current-only `bufferMappings` and a
separate `bufferMapping` current/peak summary. Existing allocation,
submission, and readback fields are not reinterpreted or dual-written.
General mapping does not increment `readbackMemory.activeMappings`.

## Remaining WebGPU/WGSL Parity

This audit closes core WebGPU buffer host mapping only. It does not claim
`GPUExternalTexture`, RenderBundle, ShaderModule/Program decomposition,
optional fragment stages, SurfaceTextureLease, debug markers, direct texture
readback, `ReadbackOperation.map()`, TextureUpload aspect selection,
`buffer_view`/broader LayoutCodec types, adapter `featureLevel`, XR/default
queue surfaces, persistent-coherent mapping extensions, worker-shared
Runtime, or complete WebGPU/WGSL parity. Those remain independent goals.

Raw `buffer.gpuBuffer` mapping is intentionally not auto-tracked. Callers that
take that escape hatch also take responsibility for native ownership,
readiness, epoch, and diagnostic behavior.
