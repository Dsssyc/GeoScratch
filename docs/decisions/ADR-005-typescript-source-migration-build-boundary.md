# ADR-005: Start TypeScript Migration Without Changing Package Output

## Status

Accepted

## Date

2026-06-16

## Context

ADR-003 chose architecture stabilization before a full TypeScript migration. Phase 2 added TypeScript as a public API contract checker, but the runtime source files are still JavaScript and the published package still points directly at `packages/geoscratch/src/*.js`.

Renaming source files to `.ts` before the package has an explicit build output boundary would force package exports, examples, and compatibility paths to move at the same time. That would mix type migration with packaging behavior and make regressions harder to isolate.

## Decision

Use a source-compatible migration path first.

For this branch:

- Keep runtime files as `.js`.
- Keep package exports and public import paths unchanged.
- Use `tsc` with `allowJs`, `checkJs`, and focused `include` entries for stable leaf modules.
- Add `// @ts-check` and JSDoc to checked JavaScript files so source intent is explicit.
- Keep adjacent `.d.ts` files synchronized until a later build-boundary ADR allows compiler-emitted declarations.

The first checked source slice is `packages/geoscratch/src/core/utils/uuid.js` because it is a stable leaf module with no WebGPU or runtime ownership dependencies.

## Consequences

- Type feedback starts on real source without changing published paths.
- The migration remains compatible with examples that import `geoscratch`.
- The project can defer `.ts` source and emitted output until package boundaries are ready.
- Future slices should expand from stable leaves toward descriptor-heavy GPU modules only after their runtime contracts are documented.

## Non-Goals

- Do not rename runtime source files to `.ts` in this branch.
- Do not introduce a package build output directory in this branch.
- Do not remove hand-written declarations yet.
