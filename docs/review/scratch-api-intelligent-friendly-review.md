# Scratch API Intelligent-Friendly Review

Status: Living temporary review
Date: 2026-06-30

This file tracks open design issues for the `scratch` API's "intelligent-friendly" goal: maximize locally-verifiable correctness while preserving direct GPU control. It is temporary in the sense that items should be revised, resolved, or replaced as the architecture matures. It is not a legacy archive.

Accepted vision still lives under `docs/vision/scratch-api/`. This review file is the working basis for follow-up design passes and should be updated whenever an item is resolved or a sharper issue appears.

## Current Review Items

### 1. Readback Version Semantics

`07-submission-readback` now says readback uses resource provenance and captures the buffer version for a readback request. The next design pass still needs to decide whether the public API needs an explicit version-pinned handle, such as `buffer.readback({ version })`, `buffer.version(v).toArray()`, or a named pending readback object.

Risk if unresolved: code may appear to read an older GPU result while actually reading the resource's latest version.

### 2. Pending Readback Leak Detection

The docs should avoid promising reliable detection of "never awaited" Promises. A more implementable contract is detecting stale pending readback operations owned by the runtime.

Risk if unresolved: the validation API may promise behavior JavaScript cannot reliably observe.

### 3. `Frame` Naming And Submission Mental Model

The accepted direction keeps `Frame` as the single submission builder, with presentation optional. That is workable, but the name can still bias readers toward display frames. All docs should consistently define `Frame` as a presentation-optional submission unit, and examples should avoid implying a surface is required.

Risk if unresolved: compute-only jobs may be misdesigned as render-loop-only workloads.

### 4. QuerySet Scope

Core WebGPU query types are timestamp and occlusion. Pipeline statistics should remain outside the core design unless a future target explicitly supports it.

Risk if unresolved: TypeScript declarations or runtime validators may expose unsupported WebGPU query types.

### 5. Buffer Layout Type Grammar

The compositional buffer layout model is valuable, but it needs a sharper typed contract. A field `format` may mean different things for CPU views, vertex attributes, WGSL storage structs, and readback. The design should define usage-specific lowering, alignment mode, and failure diagnostics.

Risk if unresolved: the API may look type-safe while still allowing invalid or misleading storage-buffer layouts.

### 6. Validation Diagnostic Schema

The intelligent-friendly loop needs machine-readable diagnostics, not only `warn` / `throw` and prose messages. A future design should define something like `ScratchDiagnostic { code, severity, path, expected, actual, hint }` for validation, shader cross-checks, resource readiness, and submission ordering.

Risk if unresolved: agents must parse natural-language errors, making iterative repair fragile.

## Update Rules

- Keep this file current when `docs/vision/scratch-api/` changes.
- Mark an item resolved only when the accepted vision docs contain the replacement contract.
- Add new items here when a review finds a design risk that should guide future architecture work.
- Do not treat old entries as archival truth; rewrite them when the design moves.
