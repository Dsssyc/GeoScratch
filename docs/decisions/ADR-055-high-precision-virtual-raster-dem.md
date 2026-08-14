# ADR-055: Use Canonical High-Precision Positions And Geo-Owned Virtual Rasters

## Status

Accepted

## Date

2026-08-05

## Context

The current Underwater Terrain example uploads one complete 1024 by 558 grayscale image and samples
it as one physical texture. The terrain selector and mesh already use geographic LoD,
but raster identity, physical storage, and filtering are still conflated. The current
Flow example similarly keeps 262,144 positions as global longitude and latitude f32
values and samples a screen-space field. Neither representation remains stable over a
large world, across page eviction, or across independent geometry and field LoDs.

WGSL has runtime f32, i32, u32, and optional f16 values, but no runtime f64 or i64
type. AbstractFloat and AbstractInt literals do not provide persistent runtime wide
precision. WebGPU textures are finite physical allocations, and texture sampling does
not understand a discontiguous application page table. GeoScratch therefore has to
represent canonical position and virtual address translation explicitly instead of
claiming precision or sparse-texture support that WebGPU does not provide.

The existing DEM mesh stitching also identifies edges with floating-point equality.
Its corrected order must be topological stitching, canonical coordinate construction,
virtual height sampling, and then camera-relative projection. Sampling before moving a
stitched vertex gives adjacent patches different height positions.

## Frozen Source Baseline

The implementation and audit use these primary sources as retrieved on 2026-08-05:

- WebGPU living specification: https://gpuweb.github.io/gpuweb/
- WGSL W3C specification: https://www.w3.org/TR/WGSL/
- OGC Cloud Optimized GeoTIFF 1.0, document 21-026:
  https://docs.ogc.org/is/21-026/21-026.html
- Rasterio documentation: https://rasterio.readthedocs.io/
- rio-cogeo documentation: https://cogeotiff.github.io/rio-cogeo/
- rio-tiler 9.4.2 documentation: https://cogeotiff.github.io/rio-tiler/9.4.2/

The Python example environment pins Rasterio 1.5.0, rio-cogeo 7.0.2,
rio-tiler 9.4.2, FastAPI 0.141.1, and Uvicorn 0.52.1. Those versions are example
tooling facts, not public GeoScratch dependencies.

The relevant normative facts are bounded:

1. WGSL explicit-level texture sampling is available to vertex, fragment, and
   compute programs, while implicit derivatives are fragment-stage behavior.
2. WGSL does not expose runtime f64 or i64 values. Optional f16 requires the matching
   WebGPU feature and WGSL enable directive.
3. A COG combines tiled TIFF storage, reduced-resolution subfiles, GeoTIFF
   georeference, and HTTP range support. Internal overviews are resolution sources,
   not a claim that one browser texture contains every level.
4. rio-tiler reads a requested tile/window from Rasterio/GDAL-backed sources. The
   temporary service is a source adapter and does not own virtual-raster policy.

## Decision

### Ownership

Scratch remains the explicit GPU execution kernel. It owns runtime, resources,
layouts, programs, pipelines, commands, passes, submissions, allocation versions,
content epochs, and Scratch diagnostics. No tile, CRS, camera, COG, terrain, layer,
or residency concept enters Scratch.

Geo owns coordinate domains, position codecs and arithmetic, transforms, virtual
raster address spaces, sampling profiles, page identity, residency, immutable
snapshots, fallback, bounded explain facts, and Geo diagnostics. Geo lowers physical
buffers, textures, uploads, bindings, and commands through public Scratch contracts.

The Underwater Terrain example and its temporary backend own source bounds, elevation scale and
offset, deterministic PNG-to-COG construction, HTTP service startup, camera policy,
terrain selection, and presentation.

### Dimensions

A coordinate domain records three independent concepts:

```text
intrinsic dimension + embedding dimension + auxiliary axes
```

The public model accepts intrinsic dimensions 1, 2, and 3. A DEM is a
`SurfaceDomain<2, 3>`: its virtual raster is addressed in a two-dimensional
parameter domain and its sampled elevation participates in a three-dimensional
embedding. Time, band, ensemble, member, and LoD are auxiliary axes rather than
invented texture dimensions. This implementation physically pages 2D rasters while
keeping coordinate and address contracts valid for 1D and 3D extension.

### Canonical Position

A dynamic object's authoritative position is LoD-independent:

```text
canonical position
    + sampling intent
    + virtual field mapping
    + immutable residency snapshot
    -> transient physical sample address
```

Tile and page IDs may be residency keys, request keys, spatial bins, dispatch cohorts,
or cache-locality hints. They are never position truth. Camera zoom, tile split or
merge, eviction, and atlas relocation cannot mutate canonical position.

Two position codecs are public and executable:

- `cell-local-f32` stores one signed integer cell and one bounded f32 local value per
  axis. Normalize, advance, difference, rebase, carry, borrow, wrapping, and
  camera-relative difference occur before conversion to local f32.
- `wide-fixed` stores a signed two's-complement 64-bit fixed coordinate as two u32
  limbs per axis. CPU and WGSL operations implement add, subtract, carry, borrow,
  relative difference, and power-of-two LoD address decomposition without decoding a
  whole-world f32 position.

Each codec publishes machine-readable precision facts: dimensions, encoding,
bytes-per-position, cell extent or fixed quantum, representable range, maximum local
ULP, quantization error, overflow and wrap policy, and supported operations. Local
vectors carry unit and basis semantics and are not interchangeable with positions.

Double-single, high/low float, Kahan summation, and compiler evaluation order are not
cross-device correctness contracts. They remain optional measured local
optimizations. WGSL f64/i64 support is not fabricated.

### Virtual Raster

The public Geo composition separates address space, source, plane/stack, sampling
profile, residency, snapshot, accessor, and sample status. It supports scalar, color,
categorical, mask, vector, multiband, and temporal planes; DEM is only the first
scalar consumer.

The 2D physical implementation has a finite texture atlas, a page table, explicit CPU
and logical GPU budgets, asynchronous request/decode/upload, deterministic LRU
eviction, parent fallback, generation and content epochs, stale-response rejection,
bounded diagnostics, and disposal. Residency mutations become visible only by
publishing a new immutable snapshot at a submission boundary. A draw or dispatch uses
one snapshot and cannot observe a partially updated page table.

Filtering is reconstructed in logical space. Nearest or bilinear sampling resolves
every footprint texel through the page table, including footprints crossing a page
edge. Physical page-edge clamping and CPU-maintained padding are not correctness
paths. Sampling explicitly accounts for outer-boundary policy, NoData, scale/offset,
requested level, and resolved fallback level.

One generated WGSL accessor contract serves vertex, fragment, and compute stages.
Vertex and compute callers supply an explicit level or logical footprint. Fragment
callers may derive sampling intent from derivatives before calling the same logical
resolver. No vertex-stage atomic feedback is required.

### DEM Clean Cut

The existing complete PNG browser upload is removed. The normal Underwater Terrain page requests
real HTTP tiles produced from the deterministic COG and uploads them into a bounded
atlas. CPU terrain selection also produces page demand; missing fine pages resolve to
resident parents rather than a hidden full-image fallback.

Mesh edge identity derives from integer sector-grid coordinates and neighbor geometry
LoD. The final stitched canonical coordinate is the sole height sample position.
`geometryLod`, `heightSamplingLod`, and `resolvedResidencyLod` remain distinct facts.
Adjacent patches use a common compatible height intent and the same immutable
snapshot, so equal logical positions resolve equal heights.

Projection uses camera-relative differences computed in the cell or integer domain.
Camera changes may alter geometry LoD, sampling intent, request priority, residency,
or reference origin, but never terrain canonical coordinates.

### COG Adapter

The example deterministically georeferences the existing grayscale PNG with the
accepted terrain bounds, north-up pixel orientation, explicit NoData, internal tiles,
overviews, and lossless compression. Its manifest records the source SHA-256
`aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1`,
CRS, transform semantics, elevation scale/offset, overview levels, and content
version. Tests compare PNG, COG, and HTTP samples at corners, center, and seeded random
locations. The source contains only 8-bit values; the adapter does not claim more
elevation precision.

### Flow Readiness Boundary

This decision does not migrate the visible Flow page. A separate real WebGPU compute
proof uses the same coordinate and virtual-raster contracts for 262,144
`cell-local-f32` positions and a multi-page vector field with at least three LoDs.
It advances positions entirely on GPU, freezes one residency snapshot per simulation
step, observes parent fallback, and performs one bounded terminal readback. It stores
no seven-part address per particle and creates no default address-materialization
pass. The current visible Flow behavior remains a regression gate.

## Diagnostics

Geo diagnostics use a versioned machine-readable envelope with stable codes, severity,
phase, subject, expected, actual, related facts, and bounded evidence. The coordinate
contract reserves at least:

- `GEO_COORDINATE_DIMENSION_MISMATCH`
- `GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED`
- `GEO_COORDINATE_CELL_OVERFLOW`
- `GEO_COORDINATE_FIXED_OVERFLOW`
- `GEO_COORDINATE_INVALID_DOMAIN`
- `GEO_COORDINATE_TRANSFORM_UNSUPPORTED`
- `GEO_COORDINATE_VECTOR_BASIS_MISMATCH`

Virtual-raster request and residency history is bounded aggregation, not an always-on
unbounded ledger. Snapshot inspection exposes current facts without retaining every
frame or sample.

## Rejected Alternatives

### Persist a seven-part virtual address on every object

Rejected. It multiplies bandwidth, couples position to LoD and residency, and forces
rewrites after page movement. Physical addresses are transient shader values.

### Materialize every address in a compute buffer

Rejected as the default. Shader-register reconstruction is cheaper for dynamic
single-use samples. A measured workload may explicitly cache reusable cohorts later.

### Use global f32 or high/low float as position truth

Rejected. Global f32 loses local increments at large magnitude; high/low arithmetic
depends on operation discipline that WGSL does not guarantee as a portable integer
contract.

### Clamp or pad each physical page

Rejected. Clamp creates seams and CPU padding makes neighboring page availability a
mutation requirement. Logical-footprint resolution is the correctness baseline.

### Preserve the full PNG as fallback

Rejected. That would hide missing residency and keep two supported DEM data paths.

### Put virtual raster in Scratch

Rejected. Address space, LoD, source, residency, and fallback are geospatial policy;
Scratch already provides the required physical execution primitives.

### Fully migrate Flow in this work

Rejected. The bounded completion point is the DEM production loop plus an executable
Flow compute-readiness proof and migration matrix.

## Consequences

- Geo gains a reusable precision and virtual-raster foundation instead of a
  DEM-shaped helper.
- DEM becomes the first complete HTTP-streamed, finite-residency consumer.
- Physical page movement and camera movement no longer redefine position.
- Cross-page filtering costs multiple page-table lookups and texture loads; this is
  explicit correctness cost and can be optimized only with measured evidence.
- The temporary Python environment is required for the Underwater Terrain example and browser gate,
  but it is isolated from the publishable package.
- The next Flow goal has a concrete compute-proven foundation and a bounded migration
  matrix rather than an untested architectural promise.
