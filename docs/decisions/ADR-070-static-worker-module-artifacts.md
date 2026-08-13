# ADR-070: Resolve Worker Contracts Through Static Module Artifacts

## Status

Accepted. This supersedes ADR-056 only for Worker module declaration, deployment,
and resolution. ADR-056 scheduling, cancellation, context, transfer, isolation, and
lifecycle decisions remain accepted.

## Date

2026-08-13

## Context

A browser module Worker ultimately requires a URL. A source-level Worker function or
TypeScript module cannot cross the structured-clone boundary, and serializing a
function with `toString()` loses imports, lexical dependencies, module semantics,
source maps, Content Security Policy compatibility, and reliable static analysis.

The DEM example previously bridged this requirement with
`dem-tile-worker-url.ts` plus a Vite/Rollup plugin that emitted the real Worker entry.
That made application source depend on one bundler's chunk-emission lifecycle. Every
new Worker module would need another URL glue file or equivalent bundler convention,
and a consumer using Webpack, native ESM, or a static server could not follow the same
GeoScratch contract.

The Worker operation API, deployment artifact, and runtime scheduling authority are
different concerns. They need one shared identity without becoming one hidden
lifecycle owner.

## Decision

Scratch publishes a framework-independent Worker module artifact protocol:

1. `defineWorkerModuleContract({ id, version })` creates one immutable identity used
   by the application, implementation, build registry, and runtime resolver.
2. A Worker source exports `contract.implement({ ... })` as its default ESM export.
   The identity is not repeated in the implementation.
3. `defineWorkerModuleBuild()` registers contracts and TypeScript entry files.
   `geoscratch-worker build --config ...` bundles each entry as a standalone browser
   ESM artifact, emits a source map, names both by SHA-256 content, and writes one
strict versioned manifest.
4. The application serves the output directory as ordinary static files and loads
   the manifest explicitly with `WorkerModuleCatalog.load()`.
5. `WorkerSystem` receives that catalog as an explicit `moduleResolver`. A group may
   then list contracts directly; it stores and exposes only resolved URL descriptors.

Artifact and source-map URLs are `./`-relative and must remain inside the manifest
directory. The directory is therefore one relocatable deployment unit; absolute,
parent, data, Blob, and cross-origin artifact URLs are invalid manifest input.

The CLI is a package-owned build step, not a Vite plugin. Vite, Webpack, another HTTP
server, or native ESM hosting only needs to serve the generated files. Generated
artifacts are replaceable build output and are not checked into the repository.

The manifest SHA-256 and byte length are deployment facts and content-addressed
names. Runtime resolution intentionally preserves native module loading rather than
fetching source into the main thread and creating Blob URLs. The catalog therefore
validates manifest structure and exact `(id, version)` resolution but does not claim
runtime Subresource Integrity. Deployments that require cryptographic transport
verification must enforce it at publication/CDN policy rather than relabeling URL
resolution as integrity verification.

`WorkerModuleCatalog` owns no Worker, fetch loop, cache, or global registry. The
application owns its fetch signal and catalog lifetime. `WorkerSystem` remains the
only Worker scheduling/lifecycle authority and still has no GPU, Cache, Geo, or DEM
dependency.

The package declares its ordinary ESM modules side-effect free so a standalone Worker
build does not retain unrelated Scratch GPU or Geo exports. The dedicated Worker
bootstrap is explicitly retained as the one top-level listener module. Other module
source must not add top-level mutable effects without revisiting that package
contract.

The build command rejects output directories outside or equal to its working project
directory, including paths that escape through an existing symbolic-link ancestor.
It will replace only an empty directory or an output carrying the GeoScratch manifest
identity, so an accidental `outDir` cannot erase an ordinary source or asset directory.
It builds into a temporary sibling and replaces existing generated output only after
every module and manifest succeeds; replacement failure restores the previous directory.

## Rejected Alternatives

- **One `new URL(..., import.meta.url)` file per Worker:** source remains coupled to
  bundler asset interpretation and repeats an unenforceable convention.
- **Vite `?worker&url` or a custom Rollup plugin:** convenient for one toolchain but
  not a GeoScratch public contract and did not reliably preserve the required
  default module definition.
- **Blob, data URL, `eval`, or function serialization:** breaks module provenance,
  imports, CSP, source maps, and agent-readable source structure.
- **Require callers to hand-author `WorkerModuleDescriptor`:** keeps URLs explicit
  but permits build/runtime identity drift and gives no repeatable artifact process.
- **Hide a global module registry inside `WorkerSystem`:** conflates deployment with
  scheduling and creates implicit lifetime and test-order state.

## Consequences

- A real Worker implementation remains a separate module, but no companion URL file
  or bundler plugin is required.
- A contract absent from the manifest fails before a Worker starts. An artifact whose
  default export disagrees with its manifest identity fails during Worker
  initialization as `WORKER_MODULE_LOAD_FAILED`.
- Applications must run the Worker build step and deploy the manifest plus hashed ESM
  files. Missing deployment fails explicitly at manifest fetch or contract resolve.
- Changing Worker source changes the content hash without forcing a semantic version
  change; changing protocol compatibility requires changing the contract version.
- The CLI currently uses esbuild internally. That is an implementation dependency,
  not part of the public artifact or runtime protocol.
