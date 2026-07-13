# Scratch Persistent Binding Views Baseline Inventory

Date: 2026-07-13
Status: Active

## Fixed Baseline

- Branch point: `dev-feature`
- Goal-start commit: `26c6d8875caea7612e573dfb4e33e1340a016d46`
- Historical pre-TypeScript JavaScript reference:
  `20bb393df570ff1914a6789e9bd422d59ddfecc8`
- Latest accepted decision at the branch point: ADR-035
- Clean baseline verification: `724 passing`
- Feature branch: `socu/scratch-persistent-binding-views-v1`

The historical JavaScript tree is a feature-parity reference only. It is not a
compatibility contract and must not restore synchronous creation, legacy API
names, hand-written declarations, or source JavaScript beside Scratch
TypeScript.

## Current Public Surface To Replace

The Goal-start package exports the following affected public contracts through
`packages/geoscratch/src/scratch/index.ts`:

- `Resource` with universal `ResourceState`, scalar `contentEpoch`, and
  `isReady`;
- `BufferResource` with optional `layout`, `elementCount`, and
  `layoutByteLength`;
- `TextureResource` with public Scratch-managed native `createView()`;
- synchronous `SamplerResource`, `QuerySetResource`, `BindLayout`, and
  `BindSet` construction paths;
- whole-resource `BindSetBindings` values;
- public lazy `BindSet.getBindGroup()`;
- `LayoutArtifact.structuralHash`;
- buffer-plus-offset/size descriptor families across upload, readback, copy,
  vertex, index, indirect, and query-resolve operations; and
- diagnostic evidence schema v4.

These names and shapes are replacement inputs, not aliases to retain.

## Native Creation Inventory

At the Goal-start commit, persistent binding-related native creation occurs at
these ownership boundaries:

| Native operation | Goal-start owner | Target owner |
| --- | --- | --- |
| `GPUDevice.createSampler()` | synchronous `SamplerResource` constructor | acknowledged `ScratchRuntime.createSampler()` transaction |
| `GPUDevice.createQuerySet()` | synchronous `QuerySetResource` constructor | acknowledged `ScratchRuntime.createQuerySet()` transaction |
| `GPUDevice.createBindGroupLayout()` | synchronous `BindLayout` constructor | acknowledged `ScratchRuntime.createBindLayout()` transaction |
| `GPUTexture.createView()` for persistent binding | public `TextureResource.createView()` and lazy BindSet lowering | candidate-local `BindSet.prepare()` transaction |
| `GPUDevice.createBindGroup()` | lazy `BindSet.getBindGroup()` | candidate-local `BindSet.prepare()` transaction |
| `GPUTexture.createView()` for pass attachments | pass descriptor lowering | submission-scoped observed lowering |

Each target transaction must issue all native calls and scope pops before its
first `await`, then recheck lifecycle and snapshot state before registration or
commit.

## Buffer-Range Migration Inventory

Every public operation that identifies a buffer and a byte range must consume a
`BufferRegion`. The migration includes:

- buffer binding, including static offsets and sizes;
- upload target;
- direct and ordered readback source;
- buffer-to-buffer copy source and destination;
- buffer sides of buffer-to-texture and texture-to-buffer copies;
- vertex and index input;
- indirect draw and dispatch arguments; and
- query-resolve destination.

The final tree must contain no `BufferResource | BufferRegion` union, implicit
whole-buffer overload, or second public offset/size representation. GPU copies
remain native GPU encoder operations in all four copy quadrants.

## Binding And Layout Migration Inventory

The Goal-start binding matrix covers uniform/storage buffers, sampled textures,
samplers, dynamic offsets, and allocation-version rebuilding, but does not yet
express the complete persistent WebGPU matrix. The target adds static buffer
ranges, `minBindingSize`, storage textures, complete sampled texture and sampler
constraints, and command-owned named dynamic offsets. `externalTexture` remains
an explicit non-goal.

The Goal-start layout compatibility key is one short `structuralHash` that also
includes semantic names. It is replaced by:

- a canonical physical ABI signature plus `abiHash`; and
- a canonical semantic schema signature plus `schemaHash`.

Compatibility always compares the canonical normalized signature after the
hash fast path. A short hash is never sole compatibility proof.

## Diagnostics Migration Inventory

Schema v4 currently represents resource, pipeline, command, readback, and
submission operation targets. Current operation kinds include buffer/texture
allocation and replacement, resource/pipeline disposal, pipeline creation,
readback staging/mapping/observation, and submission observation.

Schema v5 adds truthful `BindLayout` and `BindSet` targets and the operation
kinds `sampler-allocation`, `query-set-allocation`,
`bind-layout-allocation`, and `bind-set-preparation`. Resource targets become
discriminated so sampler and query-set records cannot inherit fabricated scalar
content or footprint fields. No v4 writer, adapter, alias, or dual output is
retained.

## Tests And Examples

Affected automated coverage spans public/type contracts, resources, layout
codecs, bindings and dynamic offsets, sampler/texture/query behavior, all copy
commands, uploads, readback, vertex/index/indirect execution, pass/submission
lowering, diagnostics, runtime facts, examples, and browser/stress fixtures.

Ordinary examples must migrate to the target API and neutral names. The exact
legacy boundary remains:

- `m_demLayer (legacy)`
- `m_flowLayer (legacy)`
- `x_helloGAW (legacy)`

DEM and Flow remain separate. The deleted Hello Map example is not restored.

## Phase Gates

This inventory is considered complete only when the final parity audit maps
every row to implementation, automated evidence, documentation, and either a
preserved capability or an explicit clean-cut replacement.
