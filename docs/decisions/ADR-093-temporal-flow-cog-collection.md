# ADR-093: Temporal Flow COG Collection and Window Adapter

## Status

Accepted for the example-owned `Flow Field` backend. This extends ADR-092; ADR-094 later adds
an explicit fixed-matrix resolution strategy without changing this collection layout. Neither
decision changes the frozen `Flow Layer` example or the public Geo/Scratch packages. The
browser continues to use the existing pre-cut RG32F artifact until its pixel-centre sampling
contract is migrated explicitly.

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

Each ordered child record includes the complete child manifest SHA. Child construction facts,
support/overview digests, COG SHA/size, and content version are invariant between batch-size one
and two. The child manifest also contains honest operational preflight observations such as
available bytes and compressed staging facts. Different observations may therefore change the
child manifest SHA and collection content version even when the COG bytes are identical; fixed
preflight observations produce the same collection identity for batch-size one and two.

### Build, locking, progress, and recovery

The collection command exposes mutually exclusive `--all-times`, half-open
`--time-range START:STOP`, and canonicalized `--time-indices` selection. The Python API takes
the explicit ordered tuple directly.

Construction occurs in a stable sibling work directory. A sibling advisory lock is held for
the whole job, not only installation. The lock file is retained so two processes cannot lock
different inodes after an unlink. Before publication the builder revalidates the originally
captured output ownership and inventory; later user content is never moved or deleted.
This is a cooperative local-build contract rather than a defence against a hostile process with
write access to the output parent. The operator must keep that parent exclusive during a job;
device/inode cleanup guards prevent observed pathname reuse but do not claim adversarial
filesystem isolation.

Recovery is snapshot-granular in this version. A completed child is verified and skipped.
An owned, completed child left in work after a crash is promoted after verification. An
incomplete GDAL file is not trusted as a checkpoint. By default it and every unrecognized
entry are preserved and construction fails closed; only the explicit combination
`--resume --discard-incomplete-work` authorizes deletion of incomplete staging inside the
matching request-owned snapshot work directory before rebuilding. The collection payload is
published with one same-filesystem rename only after every selected child and both manifests
verify. An existing published collection is never replaced without an explicit replacement
policy. Replacement moves the previous owned collection to a sibling backup and reports that
path as `replacedBackup`; the tool does not recursively delete the backup because content may
have appeared after the final ownership observation. The operator owns inspection, recovery,
and eventual cleanup of that backup.

Missing children execute in bounded batches of at most two. One batch loads station coordinates
once, creates one Delaunay topology, and traverses each spatial block once. Pixel centres and the
triangle-linear stencil are shared across the batch while field application, duplicate-velocity
statistics, support facts, semantic overviews, COG validation, manifests, progress streams, and
installation remain independent per child. Batching is execution policy only and contributes no
artifact construction field. A completed earlier child remains valid if a later child fails;
the next resume scan promotes every complete request-owned child before forming missing-only
batches.

Progress is opt-in JSONL on stderr or a caller-selected file. Stdout retains one final JSON
result. Events have stable job/stage/sequence fields and are excluded from content identity.
Ctrl-C closes current raster handles and leaves only owned recoverable work; cancellation
during GDAL `CreateCopy` is observed after the copy returns and before publication.

Preflight reports both per-snapshot work and collection storage. A full build requires an
explicit compressed-size estimate or already verified child measurements. Budgets may reject
construction, but they never reduce the statistically selected matrix, remove a model time,
or change overview semantics. The estimate is only planning input. Publication also measures
every regular file in the final payload, rejects the exact total when it exceeds
`maxCollectionBytes`, and records snapshot, runtime-manifest, collection-manifest, marker, and
total byte counts in the collection manifest's `storage` contract. Batch execution separately
bounds aggregate staged bytes and reserves free space for the transient final COG copy; these
limits and observations remain outside request and content identity. Required free space adds
the estimated remaining final bytes to the larger of the per-snapshot and aggregate-batch
staging-plus-reserve peaks, so a later child cannot fail merely because earlier final COGs have
consumed space that preflight counted twice or not at all.

### COG window to RG32F adapter

The service keeps the established network paths:

```text
GET /manifest.json
GET /tiles/WebMercatorQuad/tNN/{matrix}/{row}/{col}.rg32f
```

It does not expose the COG file and does not use an image resampler. For z15 through z7 it
opens the exact physical IFD selected by nominal factors 1 through 256 and reads an integer
window. The terminal nominal-512 IFD remains structurally and cryptographically validated but
is never a WebMercator address authority, because an arbitrary z15 tile-aligned crop need not
start on an even tile.

The historical runtime still requests z4-z9. z6, z5, and z4 are therefore derived on demand
from globally aligned z7 values with ADR-092's same four-child Float64 mean, one Float32
cast, cancellation-to-zero rule, and 3 by 3 erosion. Recursion is aligned in global
WebMercator pixel coordinates and uses positive zero outside the COG extent. Generic average,
nearest, `out_shape`, `Reader.tile()`, and the terminal extent transform are not allowed to
choose these values.

The published `runtime-manifest.json` enumerates only the bounded z4-z9 address product needed
by the current example. Publication computes each exact 524,288-byte payload SHA-256 and
maximum speed once, so the existing browser checksum and persistent-cache contract can remain
unchanged during backend migration. The underlying reader validates every physical IFD and
uses z7-z15 as addressable physical levels,
but the first service contract answers only the z4-z9 pages declared by this bounded runtime
manifest.

Every response is little-endian, pixel-interleaved RG32F with finite values and canonical
positive zero. ETags use the actual payload digest recorded at publication. Stable manifest
and tile URLs use `Cache-Control: public, no-cache` and revalidate on every reuse; a truly
immutable cache URL would need the content version in its path. Before the first conditional
`304` for a page, the adapter materializes and verifies that page's byte length, digest, and
maximum speed, then caches the result only for the unchanged COG fingerprint. Thus `304` cannot
hide a missing, replaced, or same-length-corrupted COG. Window concurrency is bounded and the
service retains aggregate counters only.

The service captures collection identity and COG fingerprints at startup rather than hot
reloading. A running process returns 503 after replacement changes an admitted fingerprint;
the operator restarts it to serve the new collection.

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
- Incomplete unmarked staging and replaced backups are retained by default; destructive
  cleanup is never inferred from a filename.
- Current free disk may legitimately reject a 27-time build. That is a capacity result, not a
  request to lower z15 or omit times.
- The COG-backed service is example-local and testable without changing the renderer,
  temporal state machine, or Geo/Scratch packages.
- Bounded two-time batches reuse each spatial stencil without changing any child artifact
  identity, and partial batch success remains recoverable at the child boundary.
- Scientific approval remains blocked until the upstream model supplies authoritative unit,
  basis, time/phase, and topology facts and the numerical error budget is accepted.
