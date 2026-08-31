# ADR-093: Temporal Flow COG Collection and Window Adapter

## Status

Accepted for the example-owned `Flow Field` backend. This extends ADR-092 without
changing the frozen `Flow Layer` example or the public Geo/Scratch packages. The browser
continues to use the existing pre-cut RG32F artifact until its pixel-centre sampling contract
is migrated explicitly.

## Date

2026-08-31

## Context

ADR-092 settles how one selected U/V time is reconstructed at the statistically supported
WebMercator ceiling and stored as a two-band Float32 COG. A hydrodynamic result is temporal,
however. The repository source contains 27 ordered U/V snapshots, while the current
`cog-cache` owns exactly one snapshot and replaces that directory on every build.

The existing browser product is a separate z4-z9 collection of pre-cut RG32F pages. Its
builder and service are complete, but it neither reads the new COG nor preserves the COG's
pixel-centre registration. Treating either product as the other would hide three real
contracts:

- every model time needs an immutable identity and a recoverable build state;
- the terminal COG overview has recursively correct nominal factor 512 values but an
  extent-preserving physical transform whose reported decimation is about 510; and
- COG samples are at standard pixel centres, whereas the historical RG32F product was sampled
  on the integer global-texel lattice.

The current source descriptor also records placeholders (`legacy-flow-unit`, `source-u-v`,
ordinal time, and `unspecified` phase). Those values must remain distinguishable from facts
confirmed by the hydrodynamic model authority.

## Decision

### Source semantics

Source descriptor schema 2 remains readable as a legacy, explicitly unconfirmed contract.
Schema 3 is additive and carries:

```text
timeUnit
authority.unit        authoritative | unconfirmed
authority.basis       authoritative | unconfirmed
authority.time        authoritative | unconfirmed
authority.phase       authoritative | unconfirmed
authority.topology    authoritative | inferred
```

`timeIndex` remains the dense runtime ordinal. `modelTime` is a finite, strictly increasing
numeric coordinate expressed in `timeUnit`. Unit, basis, phase, and time authority are
independent because confirming one does not confirm the others. The currently implemented
Delaunay fallback is always `inferred`; schema 3 rejects a claim that generated Delaunay
connectivity is authoritative. Future authoritative topology modes may make that state
available without changing the collection layout.

The descriptor generator computes file order, sizes, finite-value checks, and SHA-256 values,
but defaults every unavailable scientific fact to unconfirmed. It never infers a physical
unit, vector basis, model clock, model phase, or authoritative mesh from filenames.

Particle-simulation approval is derived from source authority and numerical QA. Metadata can
express more states without adding another runtime raster plane; the current data remains
`not-approved` because its topology and source semantics are unconfirmed.

### Collection layout and identity

The temporal product is a thin example-local collection around unchanged snapshot artifacts:

```text
cog-collection/
  .flow-field-cog-collection.json
  manifest.json
  runtime-manifest.json
  snapshots/
    t00/
      .flow-field-cog-artifact.json
      manifest.json
      flow-t00.cog.tif
    t01/
      ...
```

Each `snapshots/tNN` directory preserves ADR-092's exact three-file contract and remains
independently verifiable. The collection manifest binds the ordered selection, descriptor
identity, shared grid/encoding/overview facts, and each child manifest hash, content version,
COG hash, and COG byte length. Child topology statistics that legitimately vary with U/V,
such as maximum duplicate-vector difference, are not promoted into shared geometry identity.

The collection content version is a SHA-256-derived identity over canonical construction
facts. A full collection exactly covers the descriptor; an explicitly selected subset is a
different, valid collection and is labelled `coverage: subset`.

### Build, locking, progress, and recovery

The collection command exposes mutually exclusive `--all-times`, half-open
`--time-range START:STOP`, and canonicalized `--time-indices` selection. The Python API takes
the explicit ordered tuple directly.

Construction occurs in a stable sibling work directory. A sibling advisory lock is held for
the whole job, not only installation. The lock file is retained so two processes cannot lock
different inodes after an unlink. Before publication the builder revalidates the originally
captured output ownership and inventory; later user content is never moved or deleted.

Recovery is snapshot-granular in this version. A completed child is verified and skipped.
An owned, completed child left in work after a crash is promoted after verification. An
incomplete GDAL file is not trusted as a checkpoint and is rebuilt. The collection payload is
published with one same-filesystem rename only after every selected child and both manifests
verify. An existing published collection is never replaced without an explicit replacement
policy.

Progress is opt-in JSONL on stderr or a caller-selected file. Stdout retains one final JSON
result. Events have stable job/stage/sequence fields and are excluded from content identity.
Ctrl-C closes current raster handles and leaves only owned recoverable work; cancellation
during GDAL `CreateCopy` is observed after the copy returns and before publication.

Preflight reports both per-snapshot work and collection storage. A full build requires an
explicit compressed-size estimate or already verified child measurements. Budgets may reject
construction, but they never reduce the statistically selected matrix, remove a model time,
or change overview semantics.

### COG window to RG32F adapter

The service keeps the established network paths:

```text
GET /manifest.json
GET /tiles/WebMercatorQuad/tNN/{matrix}/{row}/{col}.rg32f
```

It does not expose the COG file and does not use an image resampler. For z15 through z6 it
opens the exact physical IFD selected by nominal factors 1 through 512 and reads an integer
window. The terminal IFD's physical transform is not treated as a WebMercator authority;
global pixel origin and window indices come from the base grid and nominal recursive factor.

The historical runtime still requests z4-z9. z5 and z4 are therefore derived on demand from
the immediately finer stored values with ADR-092's same four-child Float64 mean, one Float32
cast, cancellation-to-zero rule, and 3 by 3 erosion. Recursion is aligned in global
WebMercator pixel coordinates and uses positive zero outside the COG extent. Generic average,
nearest, `out_shape`, `Reader.tile()`, and the terminal extent transform are not allowed to
choose these values.

The published `runtime-manifest.json` enumerates only the bounded z4-z9 address product needed
by the current example. Publication computes each exact 524,288-byte payload SHA-256 and
maximum speed once, so the existing browser checksum and persistent-cache contract can remain
unchanged during backend migration. The service may also answer declared z10-z15 addresses,
but they are not advertised to the frozen browser manifest.

Every response is little-endian, pixel-interleaved RG32F with finite values and canonical
positive zero. ETags use the actual payload digest recorded at publication. A conditional
request must still prove that the declared COG exists with its startup fingerprint; `304`
cannot hide a missing or replaced artifact. Window concurrency is bounded and the service
retains aggregate counters only.

The runtime manifest declares `sampleRegistration: pixel-center`. The service does not shift
or resample bytes to imitate the historical integer-lattice product. The later frontend
migration must apply the corresponding half-texel continuous-index convention before this
collection becomes the active particle source.

## Alternatives Rejected

- One multi-page TIFF containing every time: rejected because independent immutable time
  identity, restart, replacement, and parallel distribution become harder.
- Replacing `cog-cache` for each time: rejected because it cannot represent a temporal
  product and destroys the previous time.
- A manifest containing millions of z15 page hashes: rejected because the browser requests a
  bounded z4-z9 set and the COG already supplies the immutable high-resolution identity.
- Generic COG resampling for z6, z5, or z4: rejected because it can resurrect zero support and
  confuses the terminal physical transform with a WebMercator level.
- A boundary, mask, depth, wet/dry, activity, or SDF band: rejected because dynamic support is
  still represented solely by exact U/V zero.
- Moving collection orchestration into Geo or Scratch: rejected because source files,
  hydrodynamic authority, COG production, and HTTP adaptation remain example/application
  responsibilities.

## Consequences

- The offline product can represent all model times without changing the snapshot pixel
  algorithm or future topology parameter surface.
- Interrupted jobs resume at verified snapshot boundaries and cannot silently overwrite user
  content or a conflicting published collection.
- Current free disk may legitimately reject a 27-time build. That is a capacity result, not a
  request to lower z15 or omit times.
- The COG-backed service can be completed and tested before changing the renderer, temporal
  state machine, or Geo/Scratch packages.
- Scientific approval remains blocked until the upstream model supplies authoritative unit,
  basis, time/phase, and topology facts and the numerical error budget is accepted.

