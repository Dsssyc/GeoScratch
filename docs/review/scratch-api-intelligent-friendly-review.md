# Scratch API Intelligent-Friendly Review

Status: Living temporary review
Date: 2026-06-30

This file tracks open design issues for the `scratch` API's "intelligent-friendly" goal: maximize locally-verifiable correctness while preserving direct GPU control. It is temporary in the sense that items should be revised, resolved, or replaced as the architecture matures. It is not a legacy archive.

Accepted vision still lives under `docs/vision/scratch-api/`. This review file is the working basis for follow-up design passes and should be updated whenever an item is resolved or a sharper issue appears.

## Recently Resolved

### Readback Version Semantics

Resolved in `docs/vision/scratch-api/07-transfers-epochs/`: resource identity, physical allocation changes, and content changes are now separate concepts. `allocationVersion` covers physical GPU object replacement and binding invalidation. `contentEpoch` covers bytes/texels produced by upload, copy, render, compute, clear, resolve, or mip generation. Readback now creates an explicit `ReadbackOperation`; `toArray()` / `toBytes()` live on that operation, not on `Resource`.

The accepted vision also removes core `resource.write()` sugar. CPU-to-GPU writes are explicit upload commands or higher-level helpers that lower to explicit uploads.

Coverage check for this pass:

- Resource is identity/state, not a transfer handle: covered by `02-resources` and `07-transfers-epochs`.
- `allocationVersion` vs `contentEpoch`: covered by `02-resources`, `03-bindings`, `04-pipelines-commands`, and `07-transfers-epochs`.
- Upload, readback, copy, render writes, compute writes, clear, resolve, and mip generation as content producers: covered by `07-transfers-epochs`.
- Rendering resources, including attachment writes, depth/stencil, surface current textures, resize invalidation, and temporal history textures: covered by `07-transfers-epochs`.
- No core `resource.toArray()` / `resource.toBytes()` / `resource.write()` sugar: covered by `02-resources` and `07-transfers-epochs`.
- Future-agent routing: covered by `AGENTS.md` and the `scratch-api` module index.

### Pending Readback Lifecycle

Resolved in `docs/vision/scratch-api/07-transfers-epochs/`: stale readback detection is defined over runtime-owned `ReadbackOperation` objects, not over whether a JavaScript `Promise` was awaited. The vision now defines the target operation state machine, consume-on-read default behavior, explicit retention, mapped-view leases, `cancel()` / `dispose()` semantics, staging budgets, and readback-specific diagnostic codes.

Coverage check for this pass:

- Promise await detection is explicitly rejected as the core contract: covered by `07-transfers-epochs`.
- Runtime-owned operation states from `requested` through `disposed`: covered by `07-transfers-epochs`.
- Default consume-on-read and explicit `retain: 'until-dispose'`: covered by `07-transfers-epochs`.
- Zero-copy mapped views use an explicit lease with disposal: covered by `07-transfers-epochs`.
- `cancel()` and `dispose()` semantics: covered by `07-transfers-epochs`.
- Readback retention budgets and no hidden eviction by default: covered by `07-transfers-epochs`.
- Machine-readable readback diagnostics with operation/source/epoch/age/byte context: covered by `07-transfers-epochs`.

## Current Review Items

### 1. `Frame` Naming And Submission Mental Model

The accepted direction keeps `Frame` as the single submission builder, with presentation optional. That is workable, but the name can still bias readers toward display frames. All docs should consistently define `Frame` as a presentation-optional submission unit, and examples should avoid implying a surface is required.

Risk if unresolved: compute-only jobs may be misdesigned as render-loop-only workloads.

### 2. QuerySet Scope

Core WebGPU query types are timestamp and occlusion. Pipeline statistics should remain outside the core design unless a future target explicitly supports it.

Risk if unresolved: TypeScript declarations or runtime validators may expose unsupported WebGPU query types.

### 3. Buffer Layout Type Grammar

The compositional buffer layout model is valuable, but it needs a sharper typed contract. A field `format` may mean different things for CPU views, vertex attributes, WGSL storage structs, and readback. The design should define usage-specific lowering, alignment mode, and failure diagnostics.

Risk if unresolved: the API may look type-safe while still allowing invalid or misleading storage-buffer layouts.

### 4. Validation Diagnostic Schema

The intelligent-friendly loop needs machine-readable diagnostics, not only `warn` / `throw` and prose messages. Readback-specific diagnostics are now covered in `07-transfers-epochs`, but a future design should still define the general schema for validation, shader cross-checks, resource readiness, and submission ordering.

Risk if unresolved: agents must parse natural-language errors, making iterative repair fragile.

## Update Rules

- Keep this file current when `docs/vision/scratch-api/` changes.
- Mark an item resolved only when the accepted vision docs contain the replacement contract.
- Add new items here when a review finds a design risk that should guide future architecture work.
- Do not treat old entries as archival truth; rewrite them when the design moves.
