# ADR-054: Use TypeScript Geo Source And Dist Package Output

## Status

Accepted

## Date

2026-07-26

## Context

The existing Geo module consisted of JavaScript implementations plus adjacent
hand-written declaration files. The runtime source and public type surface had
already drifted: the declarations described `MapOptions`, while the generated
`geoscratch/geo` package declaration did not export it, and two-dimensional
coordinate values were exposed only as unconstrained `number[]`.

Scratch already established a TypeScript source-first package boundary in
ADR-006. The current Geo helpers and tiling node are stable leaf modules, so
retaining a second hand-written type source no longer provides useful
compatibility.

## Decision

The current Geo implementation is TypeScript source-first:

- `packages/geoscratch/src/geo/` contains `.ts` implementation source only.
- The direct compatibility re-exports under `src/core/geo/` and
  `src/core/quadTree/` are TypeScript re-exports of the same Geo values.
- Adjacent same-source JavaScript and hand-written declarations are removed.
- TypeScript emits package JavaScript and declarations under `dist/geo/` and
  the matching `dist/core/` compatibility paths.
- `geoscratch/geo` remains the focused public package subpath.
- `MercatorCoordinate`, `GeoQuadNode2D`, and the `Node2D` runtime alias retain
  their existing behavior and identity.
- `MapOptions` is emitted as a type-only export, and two-dimensional coordinate
  inputs and outputs use explicit tuple contracts.
- TypeScript source keeps `.js` relative specifiers so emitted ES modules work
  in browsers and Node without rewriting imports.

## Non-Goals

This migration does not design or implement CRS registries, projection
pipelines, datum transformations, axis-order policy, units, new tile keys,
LoD, streaming, residency, or any other future Geo architecture. It also does
not change Scratch API contracts or migrate unrelated legacy modules.

The old formulas and lifecycle behavior remain evidence for later Geo design;
TypeScript migration does not silently correct or reinterpret them.

## Consequences

- Current Geo implementation and public declarations now have one source of
  truth.
- Package consumers continue to receive JavaScript and declarations from
  `dist/geo/`.
- Compatibility paths preserve runtime identity without duplicating
  implementation or declarations.
- Future projection and lower-level Geo work can start from explicit types
  without treating the current helpers as the final architecture.
