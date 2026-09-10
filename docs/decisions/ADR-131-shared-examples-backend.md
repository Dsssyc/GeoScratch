# ADR-131: Shared Examples Backend

## Status

Accepted

## Date

2026-09-11

## Context

Underwater Terrain and Flow Field each had a Python environment, package,
HTTP entrypoint, and browser-specific localhost port. The services could run
concurrently, but example browsing required manual process management. Both
use FastAPI and compatible pinned dependencies.

## Decision

`examples/backend/` owns one Python project and environment. The existing
`geoscratch_dem_tiles` and `geoscratch_flow_field_tiles` modules remain separate
packages within its source tree. The shared FastAPI application mounts them at
`/api/dem` and `/api/flow`, preserving each module's relative endpoints, payloads,
cache policy, diagnostics, statistics, and data-admission rules.

The host attempts each module's initialization independently. An initialization
failure produces a bounded HTTP 503 diagnostic for that module and a full server
log; it does not abort admission of other datasets. `/api/health` distinguishes
process liveness from per-module startup admission. It does not claim to detect
all later artifact changes or provide process-level fault isolation.

Source data and generated artifacts retain their existing example-owned paths.
Construction remains an explicit offline operation. Shared service startup never
builds, replaces, deletes, or hot-reloads data. Flow's immutable collection
identity, fingerprints, source authority, tool-version construction identity,
and HTTP contracts remain governed by their existing ADRs. Historical data and
the frozen Flow Layer example are outside this change.

Standalone module serving commands remain in the shared environment for tests
and explicit endpoint overrides. The npm development entrypoint owns Vite
and one shared backend, with relative browser API URLs proxied through Vite.
Shutdown and failed startup must clean only children owned by that invocation.
Installing dependencies and generating datasets remain separate commands.

This infrastructure belongs to examples; it adds no Scratch or Geo library API,
rendering policy, resource authority, or publication semantics.

## Verification

Verify each original Python suite in the shared environment, exact HTTP payload
and header preservation through mounts, independent missing-data behavior,
relative URL resolution, process shutdown/failure cleanup, and switching both
examples through one running backend. Run repository documentation, TypeScript,
Mocha, and build gates after integration.
