# ADR-057: Publish Scratch And Geo As The Only Public Concepts

## Status

Accepted

## Date

2026-08-05

## Context

GeoScratch previously exposed one flat package root plus separate Scratch, Worker,
Geo, and geometry subpaths. Its implementation also retained a second JavaScript
GPU stack beside the TypeScript Scratch kernel. That topology made ownership
ambiguous: `ScratchRuntime` appeared to own every foundation capability even though
GPU execution and Worker scheduling have independent state and lifecycles, while
root-level exports obscured whether a contract belonged to the domain-neutral
foundation or to geospatial adaptation.

GeoScratch remains at `0.x.x`. Keeping compatibility aliases would preserve two
architectures and force every later Cache and Geo decision to account for obsolete
entrypoints, names, declarations, and runtime paths.

## Decision

GeoScratch publishes exactly two concepts:

- `scratch` is the domain-neutral capability foundation;
- `geo` is geospatial semantic adaptation built on public Scratch contracts.

The dependency direction is one-way: `geo -> scratch`. Scratch cannot depend on
Geo, CRS, tile, virtual-raster, DEM, map, or globe concepts. This is summarized as
**Geo from the Scratch**.

### Public Entrypoints

The complete public export map is:

```text
geoscratch
geoscratch/scratch
geoscratch/geo
geoscratch/package.json
```

The formal capability surfaces are `geoscratch/scratch` and `geoscratch/geo`.

The package root exports only namespace values:

```ts
import { geo, scratch } from 'geoscratch'
```

Direct capability imports use the formal subpaths:

```ts
import { GPURuntime, WorkerSystem, plane } from 'geoscratch/scratch'
import { MercatorCoordinate, WebMercatorQuad } from 'geoscratch/geo'
```

The `geoscratch/worker` and `geoscratch/geometry` subpaths are deleted. Root-level
flat GPU, Worker, geometry, and Geo exports are deleted. No compatibility aliases,
conditional fallbacks, or duplicate implementation paths remain.

### Scratch Capability Domains

GPU, Worker, geometry, diagnostics, and future persistent Cache contracts share one
Scratch public facade, but they do not share mutable runtime state.

- `GPURuntime` exclusively owns adapter/device selection, surfaces, GPU resources,
  programs, pipelines, commands, submissions, native observations, and GPU
  diagnostics.
- `WorkerSystem` exclusively owns worker hosts, groups, modules, queues, task
  priority, cancellation, contexts, transfer protocol, failure convergence, and
  reclamation.
- Geometry factories are stateless Scratch helpers.
- `PersistentCache` owns browser storage state independently, as accepted by ADR-058.

No aggregate `ScratchRuntime` or `ScratchPlatformRuntime` is introduced. Consumers
construct only the authorities they need and compose them at application or Geo
boundaries.

### Diagnostics

Scratch exposes one machine-readable, domain-discriminated diagnostic family:

```ts
type ScratchDiagnostic = GPUDiagnostic | WorkerDiagnostic | CacheDiagnostic
```

`ScratchDiagnosticError`, `createScratchDiagnostic()`,
`createScratchDiagnosticReport()`, and `isScratchDiagnosticError()` are shared
envelope operations. GPU and Worker retain independent codes, phases, subjects,
facts, histories, and lifecycle authorities. An error context must match the
diagnostic domain, so unification does not mix GPU incidents with Worker remote
failure facts.

### Source And Naming Boundary

Package source is TypeScript source-first. Production source contains no same-source
JavaScript or handwritten declaration twins; JavaScript and declarations are build
outputs under `dist/`.

GPU-specific public names use `GPU*`, including `GPURuntime`,
`GPURuntimeDiagnostics`, and `GPUDiagnosticCapture`. Cross-domain diagnostic names
retain `Scratch*`; Worker names retain `Worker*`. The old names have no aliases.

### Relationship To ADR-056

This decision supersedes ADR-056 only for Worker public topology: Worker now lives
under `geoscratch/scratch`, not an independent package subpath. ADR-056 remains
authoritative for Worker scheduling, priority, cancellation, stateful contexts,
transferable ownership, failure isolation, diagnostics, disposal, and host
reclamation semantics. Its Geo tile-matrix and virtual-raster decisions are also
unchanged.

### Explicit Exclusions

Goal 1 ended at the Scratch/Geo topology and TypeScript clean cut.

- Goal 2 is implemented by ADR-058: the independent Scratch Persistent Cache uses
  IndexedDB metadata and OPFS raw payloads.
- Goal 3 is implemented by ADR-059: Geo supplies a pure virtual-raster cache address
  adapter and DEM validates persistent raw-page reuse.
- This decision does not migrate DEM caching, redesign virtual-raster residency, or
  make Flow Layer virtual-raster aware.

These exclusions bound delivery; they do not authorize temporary compatibility APIs
or a second architecture.

## Consequences

- Users can identify ownership from the import path and symbol name.
- GPU and Worker can be used independently without hidden construction or shared
  lifecycle state.
- Geo composes Scratch publicly and cannot reach into Scratch implementation paths.
- Existing consumers must migrate imports and renamed GPU types immediately.
- Historical ADRs retain their original names as evidence; an exact audited
  allowlist distinguishes those references from active API usage.
