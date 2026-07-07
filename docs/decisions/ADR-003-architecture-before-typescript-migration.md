# ADR-003: Stabilize Architecture Before Full TypeScript Migration

## Status

Accepted

## Date

2026-06-16

## Context

GeoScratch has two major modernization goals:

1. Make the architecture more flexible while preserving the library's design philosophy: direct WebGPU control, low CPU overhead, and GPU-driven rendering where possible.
2. Migrate the JavaScript codebase toward TypeScript so public APIs, runtime contracts, and package boundaries are easier to understand and maintain.

These goals are related but should not be treated as equal first steps. The current package already has a publishable ES module boundary, hand-written declaration files, compatibility entrypoints, examples that consume the package workspace, and ADRs for rendering decisions. At the same time, important runtime boundaries are still evolving: global device and director state, event-driven GPU resource creation, pass and pipeline ownership, binding lifecycle, dirty update flow, and the package's currently open `./src/*` export.

A full TypeScript conversion before these boundaries are settled would likely type and preserve temporary architecture instead of clarifying it.

## Decision

Prioritize architecture boundary stabilization before a full TypeScript migration.

TypeScript should still be introduced early as a contract and validation tool, but not as a repository-wide file conversion project. The migration should follow the architecture work instead of freezing the current runtime shape.

The working order is:

1. **Architecture boundary pass**
   - Define which modules are public API and which are internal runtime implementation.
   - Clarify dependency direction between `core`, `gpu`, `geo`, `geometry`, `effects`, `applications`, and `examples`.
   - Decide whether global `device` and `director` remain the primary runtime model or whether a runtime/context object should own device, queue, caches, stages, and resource registries.
   - Narrow package exports over time so consumers rely on supported entrypoints instead of arbitrary `src` paths.

2. **Type contracts before file conversion**
   - Use stricter declaration files, JSDoc, or `checkJs` to describe important contracts while implementation is still JavaScript.
   - Start with descriptor objects, resource lifecycle APIs, binding/pass/pipeline contracts, and public exports.
   - Treat type errors as boundary feedback: if a type is hard to express, first check whether the runtime abstraction is too broad or unclear.

3. **Performance-sensitive runtime cleanup**
   - Reduce per-frame CPU work in dirty update lists, buffer writes, binding completion checks, pass execution, and pipeline readiness checks.
   - Make GPU resource creation, caching, invalidation, and reuse explicit enough that repeated frames mostly submit prepared GPU work.
   - Prefer changes that move repeated work to GPU-side resources, persistent buffers, cached bind groups, render bundles, or compute passes where they fit the rendering model.

4. **Incremental TypeScript migration**
   - Convert stable leaf modules first, such as pure data, math, geo, and geometry helpers.
   - Then convert descriptor-heavy GPU modules after their architecture contracts are stable.
   - Keep examples importing `geoscratch` rather than source files so TypeScript migration does not leak internal paths into demos.
   - Keep declaration files synchronized during the transition and eventually let the TypeScript compiler emit declarations once the package build supports it.

## Completion Signals

The architecture-first phase is ready to hand off to broader TypeScript migration when:

- Public package entrypoints are explicit and intentional.
- Internal modules can change without requiring example or consumer imports through `packages/geoscratch/src/*`.
- Device, director, resource, pass, pipeline, and binding ownership rules are documented and reflected in code.
- Per-frame CPU update paths are easy to identify, measure, and avoid when no resource changed.
- The public API surface has enough type coverage that TypeScript migration can preserve behavior instead of rediscovering contracts.

## Non-Goals

- Do not perform a one-shot rewrite from JavaScript to TypeScript.
- Do not redesign the library into a high-level scene graph that hides WebGPU resource control.
- Do not optimize by adding broad abstractions that make GPU work less explicit.
- Do not remove compatibility entrypoints without a separate deprecation decision.
- Do not let examples depend on internal source paths as a shortcut during migration.

## Alternatives Considered

### TypeScript-First Migration

Converting all `.js` files to `.ts` first would quickly improve editor tooling and make many implicit shapes visible. It was rejected as the first major goal because it would make unstable runtime boundaries more expensive to change and could accidentally turn current implementation details into de facto public contracts.

### Architecture-Only Refactor Without Type Work

Refactoring architecture while ignoring types would avoid migration overhead, but it would miss a useful feedback loop. Descriptor objects, lifecycle rules, and public exports should be type-checked early enough to expose unclear contracts while they are still cheap to adjust.

### Full Runtime Rewrite

A clean rewrite could produce a more coherent API, but it would discard working examples, rendering decisions, and compatibility guarantees. The preferred path is incremental: make boundaries explicit, improve the runtime where the current design already points, then migrate stable modules.

## Consequences

- Architecture decisions stay reversible while the runtime model is being clarified.
- TypeScript becomes a guardrail for API contracts instead of the main refactor vehicle.
- Performance work can focus on actual WebGPU submission, resource reuse, and CPU-side scheduling costs.
- The migration path remains compatible with existing examples and public entrypoints.
- Future ADRs should be written for specific boundary changes, such as package export narrowing, runtime context ownership, or resource lifecycle redesign.
