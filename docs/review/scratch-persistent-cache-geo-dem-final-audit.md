# Scratch Persistent Cache And Geo DEM Final Audit

Date: 2026-08-06
Status: confirmed-clean
Decisions: ADR-057, ADR-058, ADR-059

## Fixed Scope

- Goal-start commit: `5d5ccb32d421bc6d89d9b2b7af34c5ea427ff360`
- Audited implementation commit: `daf68137da41e7df30f7ca23929f60f3e010ef3e`
- Branch: `dev-feature`
- Integration policy: local commits only; no remote push
- Diff: 44 files, 4,437 insertions, 1,899 deletions

The accepted target was Goal 2 plus Goal 3 only: add a domain-neutral Scratch
persistent cache, replace the former Geo cache runtime with a pure address adapter,
and prove raw DEM page reuse in the existing WebMercatorQuad virtual-raster example.
Flow virtual-raster LoD, application memory caching, Service Worker ownership, and
Cache-to-GPU conversion APIs remained explicit non-goals.

## Accepted Result

`geoscratch/scratch` now owns `PersistentCache`, `persistentCacheKey()`, cache
diagnostics, and their public types. IndexedDB is the authoritative metadata commit
point; OPFS stores immutable raw payloads. The implementation supports metadata-only
records, first-writer-wins immutable identity, entry/byte LRU, exact and prefix
invalidation, clear, explicit garbage collection, corruption repair, bounded facts,
and an idempotent `active | disposing | disposed` lifecycle. It has no Worker, GPU,
Geo, Buffer, Texture, or built-in JavaScript memory-cache dependency.

`geoscratch/geo` now exposes only `virtualRasterCacheAddress()` and its address,
metadata, coherence, and invalidation-prefix contracts. It owns no storage backend,
budget, runtime, or lifecycle. The former `VirtualRasterCache` runtime/store/policy
surface was removed without compatibility aliases. Component and composed-key
failures remain in the structured Geo diagnostic domain.

The DEM example supports only `cache=none|persistent`. Persistent misses fetch PNG,
decode one raw uint8 height page, retain one request-bounded snapshot until stale
acceptance, and then persist it. Hits transfer caller-owned raw bytes directly into
residency without another network request or image decode. Cache, Worker, page,
scheduler, residency, and GPU lifecycle authorities remain separate.

## Bounded Review

One review was performed over `5d5ccb3..HEAD`. It found and resolved these concrete
issues before acceptance:

1. Garbage collection originally deleted from a stale cross-context payload
   snapshot. Commit `7a859f1` added an IndexedDB recheck and required the writer's
   pending journal to remain live at metadata commit.
2. Open/read corruption cleanup could delete a concurrently repaired valid record.
   Commit `0c8f30e` made invalid-record deletion conditional in the same readwrite
   transaction and added a deterministic browser race proof.
3. OPFS namespace encoding accepted malformed Unicode and could exceed a safe path
   component. Commit `0c8f30e` requires well-formed Unicode and at most 120 UTF-8
   bytes, preserving injective hexadecimal directory names.
4. Individually bounded Geo fields could still overflow the composed Scratch key or
   leak `URIError`/cache diagnostics. Commit `0c8f30e` validates the aggregate and
   returns `GEO_VIRTUAL_RASTER_CACHE_ADDRESS_INVALID`.
5. The complete normative-proof suite made one synchronous manifest test exceed
   Mocha's default two-second budget. Its unchanged assertions passed alone in
   1.3 seconds; commit `daf6813` aligned that heavy test with the file's existing
   ten-second proof budgets. The full suite then passed.

No unresolved Goal 2/3 correctness finding remains.

## Verification Evidence

Environment:

- Node.js `v25.8.1`
- npm `11.11.0`
- Chrome `150.0.7871.188`, Apple Metal 3 WebGPU adapter
- Python `3.14.5`, pytest `9.1.1`

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Passed package emit, repository TypeScript, examples, and WebGPU types |
| `npm test -- --reporter dot` | 1,262 passing, 2 intentionally pending |
| `npm run build` | Passed package and production examples build; existing >500 kB Vite chunk warning only |
| `node tests/browser/scratch-persistent-cache.mjs` | Passed raw/meta records, immutable put, LRU, reload, invalidation, GC, lifecycle, and all three deterministic cross-context races |
| DEM browser proof, Vite dev | Passed; return reached 3 hits while decode/network remained 7/11; reload reached 2 hits with 0 decode and 0 network |
| DEM browser proof, production preview | Passed with the same raw-hit and zero-repeat-decode guarantees |
| `node tests/browser/scratch-hello-gaw.mjs` | Passed 240 proof frames, resize generation 1, no incidents or browser failures |
| `node tests/browser/scratch-flow-layer.mjs` | Passed 660-frame target, camera reprojection, estuary boundary, two failure injections, and terminal disposal |
| DEM tile-server pytest | 11 passed |
| `rio cogeo validate` | Generated DEM is a valid Cloud Optimized GeoTIFF |
| Scratch public-topology target audit | Passed: 1,173 entries, 1,360 facets, 44 target additions |
| `git diff --check` | Passed |

The first final Flow invocation completed its normal 660-frame proof but lost the
Playwright execution context during the deliberate navigation into the boundary
scenario. A clean rerun completed the normal, boundary, and failure proofs with exit
code zero. No Flow source changed in this goal, and no Goal 2/3 failure was hidden.

## Specification Authority

- Indexed Database API 3.0: https://w3c.github.io/IndexedDB/
- File System Living Standard: https://fs.spec.whatwg.org/
- Storage Standard: https://storage.spec.whatwg.org/

These sources support the implemented boundary: IndexedDB transactions provide the
metadata commit authority, OPFS writable completion publishes payload files, and
storage estimate/persistence APIs expose observations rather than durability
guarantees. The implementation does not claim an atomic transaction across
IndexedDB and OPFS.

## Final Classification

`confirmed-clean`: Goal 2 and Goal 3 are implemented, documented, committed, and
verified on `dev-feature`. All required product, package, browser, COG, lifecycle,
diagnostic, topology, and repository-cleanliness gates pass. No push was performed.
