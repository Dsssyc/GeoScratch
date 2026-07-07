# ADR-006: Use TypeScript Scratch Source and Dist Package Exports

## Status

Accepted

## Date

2026-07-07

## Context

The Scratch API implementation under `packages/geoscratch/src/scratch/` was JavaScript source plus adjacent hand-written declaration files. That dual-source shape made the API harder to audit because runtime ownership, resource lifecycle, command compatibility, diagnostics, and generated public types could drift.

The package also previously exposed source files through `./src/*`. That compatibility aperture is no longer coherent for Scratch because the public package door is compiled output, while Scratch source is TypeScript.

## Decision

Scratch core source is TypeScript source-first under `packages/geoscratch/src/scratch/`. The package entry wrappers are TypeScript source as well:

- `packages/geoscratch/src/index.ts`
- `packages/geoscratch/src/scratch.ts`

The publishable package entrypoints resolve through dist outputs:

- `geoscratch` -> `dist/index.js` and `dist/index.d.ts`
- `geoscratch/scratch` -> `dist/scratch.js` and `dist/scratch.d.ts`
- `geoscratch/geo` -> `dist/geo/index.js` and `dist/geo/index.d.ts`
- `geoscratch/geometry` -> `dist/geometry/index.js` and `dist/geometry/index.d.ts`

The package no longer exports `./src/*`. Tests, examples, and documentation must consume public package entrypoints rather than Scratch source paths.

## Consequences

- Scratch source has one type-aware implementation source of truth.
- Public declarations are emitted by TypeScript instead of hand-written beside Scratch source.
- Package consumers use stable dist outputs rather than repository source layout.
- Legacy non-Scratch JavaScript modules can remain JavaScript until separately migrated.
