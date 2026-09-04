# ADR-095: Bounded Flow Runtime Dataset Manifest

## Status

Accepted and implemented for the example-owned `Flow Field` COG collection backend. This
supersedes ADR-093's runtime-manifest schema-one and fixed z4-z9 publication clauses while
preserving its immutable snapshot, semantic overview, HTTP, cache, recovery, and service
boundaries. It does not change the frozen `Flow Layer` example or public Geo/Scratch APIs.

## Date

2026-09-04

## Context

ADR-093 introduced a temporal collection and an HTTP adapter, but its browser manifest was a
compatibility superset of the historical pre-cut page manifest. It fixed the public page range
to z4-z9, repeated construction-only facts, identified times primarily by numeric index, and
did not expose source authority or quality as first-class runtime facts.

ADR-094 then added an explicit z10 COG base. Publishing only through z9 would hide the selected
base precision from the browser. Publishing every level through a statistical z15 or finer
base would have the opposite failure: for the current extent, z15 alone contains 82,775 pages
per time and would turn the runtime manifest, page hashing, startup validation, and browser
index into an unbounded product.

A selected subset also retains original source time indices. Treating `timeIndex` as an array
offset or assuming every two published samples are temporally adjacent would make subset
collections either unreadable or falsely interpolable.

## Decision

### Versioned runtime contract

The COG runtime manifest uses schema version 2. The COG collection manifest uses schema version
2, adapter identity `flow-cog-wmq-rg32f-v2`, and a `-v2` collection content-version suffix.
Tool package `0.7.0` owns this contract. Historical pre-cut `cache` schema-one artifacts remain
unchanged and are validated only by their existing backend.

The runtime manifest promotes these browser-relevant facts:

- complete dataset, source revision, descriptor hash, and collection content identity;
- `sourceCeiling`, including WebMercatorQuad matrix and statistical or explicit selection
  relation;
- complete source authority and particle-simulation quality;
- one pixel-centre RG32F representation with exact-zero unsupported velocity and missing-page
  semantics of `unavailable`;
- ordered time samples with stable `sampleKey`, original `timeIndex`, numeric `modelTime`, unit,
  phase, and immutable source hash;
- explicit temporal coverage and adjacency records;
- ordered page records containing `sampleKey`, canonical relative `path`, exact byte length,
  SHA-256, and maximum speed; and
- independently bounded construction, page, and storage facts.

`sampleKey` is the runtime resource identity. `timeIndex` remains provenance from the source
descriptor and must not be used as an array offset. The service path continues to use the
sample key:

```text
GET /tiles/WebMercatorQuad/{sampleKey}/{matrix}/{row}/{col}.rg32f
```

Clients resolve the URL from each declared relative `page.path`; they do not reconstruct a
path from time or tile fields.

### Temporal adjacency

`temporal.sampleAdjacency` has one record between every pair of consecutive published samples.
When the pair is consecutive in the complete source descriptor, the record is
`interpolable/component-wise-linear`. When omitted source samples lie between the pair, it is
an explicit `gap/none/omitted-source-samples` record. A single-time collection has no adjacency
records, and the final sample never implicitly connects to the first.

This metadata does not add a raster plane. It prevents a frontend from inventing temporal
continuity that the selected collection did not publish.

### Bounded matrix publication

Source reconstruction precision and browser publication are separate facts:

```text
publishedMaximum = min(sourceCeiling, z10)
publishedMatrices = every matrix from z4 through publishedMaximum
```

The collection still requires a COG base of at least z9. A z9 COG therefore publishes z4-z9;
z10 and finer COGs publish z4-z10. The manifest records the real `sourceCeiling` and uses the
tile-matrix-set `maxTileMatrix` as the sole public request ceiling. Construction records the
z10 cap and resolved maximum, so changing this policy changes collection identity.

All snapshots in one collection must share the same COG base. The page index rejects readers
with another base even when both readers happen to support the advertised lower levels.

### Validation and service behavior

The page-set digest includes the sample key and canonical relative path as well as time, tile,
payload, and speed facts. Collection verification cross-checks source ceiling, matrix policy,
time samples, authority, quality, representation, pages, and page-set identity rather than
accepting a merely self-consistent runtime JSON document.

The collection source facts embed the complete descriptor identity inventory used by
`source_descriptor_hash()`: every source time index, model time, filename, payload hash, count,
and semantic authority input. Verification recomputes that hash before classifying the
published selection as full or subset. Repeating `fieldCount` in several outer objects is not
treated as independent evidence.

The service continues to expose stable `/manifest.json` and tile URLs with ETag revalidation.
For a COG collection, `/manifest.json` is the exact `runtime-manifest.json` bytes. A missing
page remains unavailable and is never converted to velocity `(0, 0)`. The server snapshots
collection and COG fingerprints at startup; a replacement still requires restart.

### Frontend sample registration

Schema-two COG pages are pixel-centre samples, while the public Geo Virtual Raster sampler
addresses a global texel lattice. `Flow Field` therefore adapts registration locally on top of
the public sampler; neither Scratch nor Geo acquires COG-specific policy.

For each attempted common Virtual Raster level, the adapter subtracts exactly half of that
level's texel in wide-fixed WebMercator quanta from the original physical position before both
time samples are evaluated. If either public sampler resolves to a coarser level, the tentative
values are discarded and the half-texel offset is recomputed from the original position for the
new common level. Reusing the fine-level offset at a parent would introduce a quarter of a
parent-pixel phase error. Offsets use both fixed-point limbs and saturate at the global north/west
origin; they are never narrowed to `i32` or converted through whole-world `f32` coordinates.

Registration is a source representation fact, not a frame uniform. The compatibility source
for the historical direct page cache remains `global-texel-lattice`; only a source backed by the
schema-two COG runtime manifest selects `pixel-center`. Current and next temporal sources must
declare the same registration before sharing a sampler module.

## Verified z10 Runtime Proof

The current t00 source was published through the schema-two adapter in an isolated collection.
The runtime manifest is 46,215 bytes and declares 169 pages across z4-z10, including all 110
z10 pages for the source extent. Deep collection verification passed with page-set SHA-256
`92c5e3a632288c5181ab5c06f18b88b17fdef71bcd62861a52a629cdf67e3d26` and collection content
version `flow-cog-collection-5f3f82631332c072-t1-z10-v2`. The one-sample subset declares zero
adjacency records against the complete 27-sample source instead of inventing a loop or interval.

The complete 27-sample source was subsequently published through z10. Its runtime manifest is
1,172,702 bytes and declares 4,563 pages with 2,392,326,144 bytes of decoded RG32F page payload.
Identity-only and deep verification passed with page-set SHA-256
`461518f8ecfb4da65e5ac9e4b8a5deb23d0a06d9f9a2b0b291c9868b8bb6686d` and content version
`flow-cog-collection-10e94fd373678507-t27-z10-v2`.

## Consequences

- The explicit z10 resource can be addressed at z10 without exposing arbitrarily fine COG
  bases as millions of browser page records.
- Full and subset time products use the same runtime schema without dense-index assumptions.
- Scientific approval and source authority are visible to the frontend without another
  texture or network data plane.
- The runtime manifest is a frontend dataset contract, while collection and snapshot manifests
  remain backend construction contracts.
- The schema-two loader, sample-key source, and registration adapter can coexist with the
  historical cache; the application remains on that cache until the temporal window migrates
  explicitly.

## Alternatives Rejected

- Keep z4-z9 permanently: rejected because it hides an explicitly selected z10 base.
- Publish through every COG base: rejected because a z15 default creates a multi-million-page
  temporal index for the current source.
- Treat adjacent published array entries as interpolable: rejected because subsets may omit
  source samples.
- Use `timeIndex` as the runtime key: rejected because subset indices need not be dense.
- Serve TIFF URLs directly to the renderer: rejected because COG windowing, RG32F payload
  validation, caching, and service replacement remain source-adapter responsibilities.
- Encode validity, authority, or quality as another raster channel: rejected because they are
  resource or metadata facts, not per-pixel velocity values.

## References

- [ADR-093: Temporal Flow COG Collection and Window Adapter](./ADR-093-temporal-flow-cog-collection.md)
- [ADR-094: Explicit Flow COG Base Resolution](./ADR-094-explicit-flow-cog-resolution.md)
