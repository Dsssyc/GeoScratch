# ADR-036: Separate Raw Resources, Logical Views, And Layout Compatibility

## Status

Accepted

## Date

2026-07-13

## Context

Scratch currently stores one optional layout on a `BufferResource`, accepts
whole buffers and textures at persistent binding sites, and exposes native
texture views through `TextureResource.createView()`. This collapses physical
storage, byte-range selection, semantic interpretation, and allocation-scoped
native objects into one layer. It prevents one buffer from carrying multiple
valid interpretations and lets persistent objects retain native views after a
texture allocation changes.

`LayoutArtifact.structuralHash` also conflates physical GPU-visible layout with
semantic field naming and uses a short hash as the compatibility fact. Equal
hashes alone are not collision-safe proof, while physical compatibility and
typed schema compatibility are different questions.

Sampler and query-set inheritance from the current universal resource state
adds another false abstraction. Samplers have allocation lifetime but no
content epoch. Query sets have indexed slot state and epochs, not one scalar
whole-object readiness value.

## Decision

### Truthful resource hierarchy

`Resource` owns runtime, identity, label, normalized descriptor, resource kind,
disposal, and physical `allocationVersion`. Only buffer and texture resources
add scalar content state, `contentEpoch`, and readiness.

`SamplerResource` has allocation lifecycle without content state, readiness, or
logical footprint. `QuerySetResource` has allocation lifecycle plus private
indexed slot states and indexed slot epochs. It exposes read-only indexed
accessors or snapshots and no scalar content epoch or whole-object readiness.

`BindLayout` and `BindSet` are supporting objects, not `Resource` subclasses.
Runtime current facts are discriminated by kind. Provisional native candidates
receive identities for labels and evidence, but become current registered
objects only after acknowledgement and lifecycle rechecks succeed.

### Raw buffer resources and immutable regions

`BufferResource` is a raw physical byte container. Its descriptor and public
object do not contain `layout`, `elementCount`, or `layoutByteLength`.

`BufferResource.region()` creates an immutable, non-extensible `BufferRegion`
with one parent buffer, an absolute byte `offset`, a byte `size`, and an optional
`LayoutArtifact` witness. Direct and subclass construction are closed. A region
is not a resource: it has no independent identity, allocation version, content
epoch, readiness, disposal, registration, or footprint.

`buffer.region()` denotes whole-buffer use. All range arithmetic uses safe
integers and explicit overflow and bounds checks. A typed region must satisfy
its layout's alignment and stride constraints; `elementCount` is derived only
when exact. Overlap is legal.

`region.subregion()` accepts a relative range, normalizes it immediately to the
parent buffer, and never retains a region-parent chain. Layout is not inherited;
an omitted layout creates a raw child.

`region.interpretAs(layout)` creates a new frozen region without copying or
transferring bytes. Raw-to-typed interpretation validates range, alignment,
stride, and size. Typed-to-typed interpretation additionally requires canonical
ABI compatibility. A physically different interpretation requires another
explicit region from the parent buffer.

Every use rechecks the parent lifecycle, current allocation bounds, required
usage, and operation-specific alignment. Allocation replacement may therefore
invalidate a previously valid region without mutating the region recipe.

### Immutable texture view specifications

`TextureResource.view()` synchronously creates an immutable, non-extensible
`TextureViewSpec`. Direct and subclass construction are closed. It stores the
parent logical texture and a complete normalized descriptor whose defaults are
materialized at creation. Logical creation never calls
`GPUTexture.createView()` and never exposes a native view.

The descriptor covers format, dimension, usage, aspect, mip and layer ranges,
and feature-gated component swizzle. Each later use revalidates the same recipe
against current allocation extent, format and `viewFormats`, dimension, sample
count, compatibility mode, usage, and device features.

Public Scratch-managed `TextureResource.createView()` is removed. Direct
`gpuTexture.createView()` remains an explicit raw escape from Scratch ownership,
diagnostics, versioning, and repair guarantees.

Persistent native views are owned only by one BindSet preparation candidate.
Equivalent recipes may be deduplicated inside that candidate, but there is no
runtime-wide or cross-BindSet cache. Pass attachment views remain
submission-scoped and are never reused through BindSet preparation.

### Dual layout compatibility

Every `LayoutArtifact` exposes `abiHash` and `schemaHash` and internally retains
immutable canonical ABI and schema signatures.

The ABI signature contains only physical GPU-visible facts: alignment mode,
byte length, structure stride, recursively normalized scalar/vector/array
types, offsets, sizes, alignments, array lengths, and strides. It excludes
labels, diagnostic prose, display names, and field names that do not change
physical representation.

The schema signature contains semantic contract facts: the logical layout/type
name where generated contracts use it, field names, nesting, field types, field
order, and array structure.

Hashes are deterministic indexes, not compatibility proof. Every compatibility
check first compares hashes and then compares the complete canonical normalized
signature. Diagnostics include both hashes and a bounded first structural
difference. Typed Program requirements default to exact schema compatibility;
native binding checks separately validate ABI, range, usage, and alignment.
ABI-compatible schema reinterpretation is explicit and never automatic.

`structuralHash` is removed without an alias or conversion shim.

### Range ownership across operations

`BufferRegion` is the only public Scratch buffer-range unit for binding, upload,
readback, all buffer copy endpoints, vertex/index input, indirect arguments, and
query resolve. There are no whole-buffer overloads or compatibility unions.

Typed uploads and typed readback decoding require matching canonical schema.
Raw byte upload remains explicit. Buffer-to-buffer copy allows different or raw
schemas and records both endpoint witnesses without treating difference as an
error. All four GPU copy quadrants remain native GPU operations; no path is
replaced by CPU readback plus upload.

Writes advance the parent content epoch. Regions do not own independent epochs,
and declared command resource access remains at parent `Resource` granularity.

## Alternatives Considered

### Keep one layout on BufferResource

Rejected. Storage identity does not determine one semantic interpretation and
cannot represent overlapping, raw, or differently typed ranges honestly.

### Allow both resources and views

Rejected. A compatibility union would preserve ambiguous whole-object semantics
and force every downstream operation to maintain two range models.

### Cache native texture views globally

Rejected. Native views are allocation-scoped. Global caching would require
reverse ownership graphs, complicate replacement, and risk retaining invalid
views.

### Trust hashes alone

Rejected. Fixed-size hashes can collide. Canonical signatures are retained and
compared before compatibility is accepted.

## Consequences

- Callers explicitly select and interpret buffer bytes and texture subresources.
- Buffer and texture resources keep truthful container semantics.
- One buffer can safely expose multiple raw or typed regions.
- Texture replacement invalidates dependent preparation snapshots without
  mutating logical view recipes.
- The API intentionally breaks every old whole-resource or resource-global
  layout path during `0.x.x`.
