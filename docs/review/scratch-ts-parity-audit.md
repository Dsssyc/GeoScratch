# Scratch TypeScript Parity Audit

## Scope

This audit checks the clean-cut Scratch TypeScript migration against the fixed branch-creation baseline.

- Fixed baseline SHA: `20bb393df570ff1914a6789e9bd422d59ddfecc8`
- Audit target branch commit: `408e6f292b0c9a4eaef13621c1ed17d95237ea48`
- Branch: `socu/scratch-ts-clean-cut`
- Result: complete, with no unresolved parity gaps.

## Summary

Scratch core moved from JavaScript plus adjacent hand-written declarations to TypeScript source-first files under `packages/geoscratch/src/scratch/`. Package entry wrappers moved to `packages/geoscratch/src/index.ts` and `packages/geoscratch/src/scratch.ts`. Package public exports now resolve through generated `dist` JavaScript and declarations.

Behavior/API/diagnostic parity was checked against the fixed baseline, not a floating branch.

Evidence:

- Old Scratch JS source modules: 16.
- New Scratch TS source modules: 16.
- Old diagnostic code occurrences: 138.
- New diagnostic code occurrences: 138.
- Old unique diagnostic codes: 57.
- New unique diagnostic codes: 57.
- Missing diagnostic codes: none.
- Old hand-written declaration exported names: 88.
- Generated Scratch declaration exported names: 96.
- Missing old declaration exported names: none.

## Module Mapping

| Baseline source | TypeScript source | Parity |
| --- | --- | --- |
| `packages/geoscratch/src/scratch/diagnostics.js` | `packages/geoscratch/src/scratch/diagnostics.ts` | Complete |
| `packages/geoscratch/src/scratch/resource.js` | `packages/geoscratch/src/scratch/resource.ts` | Complete |
| `packages/geoscratch/src/scratch/buffer.js` | `packages/geoscratch/src/scratch/buffer.ts` | Complete |
| `packages/geoscratch/src/scratch/texture.js` | `packages/geoscratch/src/scratch/texture.ts` | Complete |
| `packages/geoscratch/src/scratch/sampler.js` | `packages/geoscratch/src/scratch/sampler.ts` | Complete |
| `packages/geoscratch/src/scratch/surface.js` | `packages/geoscratch/src/scratch/surface.ts` | Complete |
| `packages/geoscratch/src/scratch/query-set.js` | `packages/geoscratch/src/scratch/query-set.ts` | Complete |
| `packages/geoscratch/src/scratch/readback.js` | `packages/geoscratch/src/scratch/readback.ts` | Complete |
| `packages/geoscratch/src/scratch/binding.js` | `packages/geoscratch/src/scratch/binding.ts` | Complete |
| `packages/geoscratch/src/scratch/program.js` | `packages/geoscratch/src/scratch/program.ts` | Complete |
| `packages/geoscratch/src/scratch/pipeline.js` | `packages/geoscratch/src/scratch/pipeline.ts` | Complete |
| `packages/geoscratch/src/scratch/command.js` | `packages/geoscratch/src/scratch/command.ts` | Complete |
| `packages/geoscratch/src/scratch/pass.js` | `packages/geoscratch/src/scratch/pass.ts` | Complete |
| `packages/geoscratch/src/scratch/submission.js` | `packages/geoscratch/src/scratch/submission.ts` | Complete |
| `packages/geoscratch/src/scratch/runtime.js` | `packages/geoscratch/src/scratch/runtime.ts` | Complete |
| `packages/geoscratch/src/scratch/index.js` | `packages/geoscratch/src/scratch/index.ts` | Complete |
| `packages/geoscratch/src/index.js` | `packages/geoscratch/src/index.ts` | Complete |
| `packages/geoscratch/src/scratch.js` | `packages/geoscratch/src/scratch.ts` | Complete |

## Module Checklist

| Module | Behavior/API/diagnostic result |
| --- | --- |
| diagnostics | Diagnostic shape, report helpers, and thrown error behavior preserved. Type-only diagnostic names are exported from package entrypoints. |
| resource | Runtime ownership, disposal checks, allocation version, and content epoch behavior preserved. |
| buffer | Descriptor validation, GPU buffer ownership, size/usage tracking, and disposal behavior preserved. |
| texture | Descriptor normalization, view cache behavior, allocation replacement invalidation, and disposal behavior preserved. |
| sampler | Descriptor normalization and GPU sampler ownership preserved. |
| surface | Runtime/surface separation, configure/resize lifecycle, format resolution, and disposal behavior preserved. |
| query-set | Query type/count validation, timestamp feature validation, slot epoch tracking, and disposal behavior preserved. |
| readback | Explicit operation lifecycle, range validation, cancellation/disposal checks, staging copy/map flow, and typed-array conversion behavior preserved. |
| binding | Bind layout validation, bind set resource validation, bind group caching, and allocation-version invalidation behavior preserved. |
| program | Shader module list, entry point contract, required feature validation, runtime ownership, and disposal behavior preserved. |
| pipeline | Render/compute pipeline construction, entry point validation, bind layout validation, target formats, and vertex layout validation preserved. |
| command | Draw, dispatch, upload, copy, query resolve, texture upload, and occlusion bracket command behavior preserved. |
| pass | Render/compute pass descriptors, timestamp writes, occlusion query set validation, and pass disposal behavior preserved. |
| submission | Explicit step ordering, pass/command compatibility checks, epoch advancement, and submitted work shape preserved. |
| runtime | Async runtime creation, device/queue ownership, resource/surface factories, device-lost tracking, and disposal behavior preserved. |
| index/scratch entrypoints | Public names and compatibility entrypoint preserved through generated dist outputs. |

## Declaration Coverage

Old hand-written declarations were removed from Scratch source. Generated declarations now exist under:

- `packages/geoscratch/dist/index.d.ts`
- `packages/geoscratch/dist/scratch.d.ts`
- `packages/geoscratch/dist/scratch/*.d.ts`

Checklist:

| Old declaration surface | Generated declaration surface | Result |
| --- | --- | --- |
| `packages/geoscratch/src/index.d.ts` | `packages/geoscratch/dist/index.d.ts` | Complete |
| `packages/geoscratch/src/scratch.d.ts` | `packages/geoscratch/dist/scratch.d.ts` | Complete |
| `packages/geoscratch/src/scratch/diagnostics.d.ts` | `packages/geoscratch/dist/scratch/diagnostics.d.ts` | Complete |
| `packages/geoscratch/src/scratch/resource.d.ts` | `packages/geoscratch/dist/scratch/resource.d.ts` | Complete |
| `packages/geoscratch/src/scratch/buffer.d.ts` | `packages/geoscratch/dist/scratch/buffer.d.ts` | Complete |
| `packages/geoscratch/src/scratch/texture.d.ts` | `packages/geoscratch/dist/scratch/texture.d.ts` | Complete |
| `packages/geoscratch/src/scratch/sampler.d.ts` | `packages/geoscratch/dist/scratch/sampler.d.ts` | Complete |
| `packages/geoscratch/src/scratch/surface.d.ts` | `packages/geoscratch/dist/scratch/surface.d.ts` | Complete |
| `packages/geoscratch/src/scratch/query-set.d.ts` | `packages/geoscratch/dist/scratch/query-set.d.ts` | Complete |
| `packages/geoscratch/src/scratch/readback.d.ts` | `packages/geoscratch/dist/scratch/readback.d.ts` | Complete |
| `packages/geoscratch/src/scratch/binding.d.ts` | `packages/geoscratch/dist/scratch/binding.d.ts` | Complete |
| `packages/geoscratch/src/scratch/program.d.ts` | `packages/geoscratch/dist/scratch/program.d.ts` | Complete |
| `packages/geoscratch/src/scratch/pipeline.d.ts` | `packages/geoscratch/dist/scratch/pipeline.d.ts` | Complete |
| `packages/geoscratch/src/scratch/command.d.ts` | `packages/geoscratch/dist/scratch/command.d.ts` | Complete |
| `packages/geoscratch/src/scratch/pass.d.ts` | `packages/geoscratch/dist/scratch/pass.d.ts` | Complete |
| `packages/geoscratch/src/scratch/submission.d.ts` | `packages/geoscratch/dist/scratch/submission.d.ts` | Complete |
| `packages/geoscratch/src/scratch/runtime.d.ts` | `packages/geoscratch/dist/scratch/runtime.d.ts` | Complete |

The generated declarations keep all old exported type/class/function names. Some implementation helper types now appear in generated module declarations because TypeScript emits structural support for source-defined unions. They do not represent new runtime behavior.

## Intentional Structural Differences

- Source files are not line-by-line translations. TypeScript interfaces and type aliases were added in the same modules so the compiler can check runtime ownership, resource descriptors, command compatibility, and diagnostic reports.
- `ScratchRuntime` now emits its private constructor from TypeScript source while preserving `ScratchRuntime.create(...)` as the public construction path.
- Package source no longer includes Scratch hand-written declarations. Declarations are generated under `dist`.
- The old package source wildcard export was removed. ADR-006 records the new package boundary.
- Two legacy JavaScript modules received JSDoc typedef imports so their generated declarations remain valid while legacy directories stay JavaScript.

## Verification At Audit Time

Commands run before this audit document:

- `npm test`: passed, 139 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed, including `scratch_renderToTexture/index.html`.
- `git diff --check`: passed.

Additional audit checks:

- Scratch source-tree JS/declaration residue check: no `packages/geoscratch/src/scratch/*.js` or `packages/geoscratch/src/scratch/*.d.ts` files remain.
- Dist entrypoint inspection: package exports point to `dist/index.js`, `dist/scratch.js`, `dist/geo/index.js`, and `dist/geometry/index.js` with matching declarations.
- Diagnostic parity script: no missing or added diagnostic codes.
- Declaration export parity script: no missing old exported names.

## Conclusion

The Scratch TypeScript migration preserves the implemented Scratch behavior, public API names, diagnostic codes, resource lifecycle semantics, command/pass/submission ordering, and generated public declaration coverage against the fixed baseline. No parity gaps remain.
