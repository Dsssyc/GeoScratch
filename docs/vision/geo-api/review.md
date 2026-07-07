# Geo API Vision Review

Status: Review note  
Date: 2026-07-06  
Scope: Preserve the current review outcome only. Do not treat the items below as immediate work.

## Context

The current `docs/vision/geo-api/` draft extends GeoScratch's forward-looking architecture docs from the `scratch` GPU kernel into the `geo` layer. Its core direction is sound: `geo` should be a geospatial visualization compiler and observable runtime above `scratch`, not a scene graph, ECS, material system, or hidden renderer.

The review conclusion is:

- Keep `scratch` focused on explicit WebGPU/GPGPU execution primitives.
- Let `geo` own geospatial semantics: sources, schemas, layers, styles, portrayal, layout constraints, tiles, LoD, residency, render/resource graphs, explainability, reproducibility, security, and agent-facing tools.
- Do not prioritize this cleanup immediately. The current project focus remains implementing and stabilizing `scratch`. Revisit this note after the `scratch` target model has real implementation weight.

## What Works Well

The draft is directionally aligned with the repository design philosophy:

- `GeoVizDocument` as a canonical, serializable project state is the right foundation for human and agent workflows.
- Patch/plan/apply separates intended changes from runtime side effects.
- Source schemas make field type, unit, CRS, domain, statistics, GPU lowering, and privacy/security policies machine-readable.
- Style and expression are treated as analyzable IR instead of arbitrary JavaScript closures.
- Portrayal, candidate generation, collision domains, placement results, and constraints are separated instead of being hidden in renderer objects.
- Tile loading, LoD, streaming, GPU residency, fallback, and degradation policies are first-class instead of implicit caches.
- RenderGraph and ResourceGraph are positioned above scratch as orchestration and introspection tools, not as a replacement for explicit scratch submission.
- Explain, trace, profile, repro, semantic tests, and security policies are correctly treated as API surface, not debugging afterthoughts.
- Agent tools are described as structured operations over documents and runtime snapshots, not natural-language shortcuts into internal renderer mutation.

## Main Issues

### 1. Documentation Shape Is Not Canonical Yet

Current layout:

- `docs/vision/geo-api/geoscratch-geo-api-vision-docs/README_zh.md`
- `docs/vision/geo-api/geoscratch-geo-api-vision-docs/00-*` through `10-*`
- `docs/vision/geo-api/geoscratch-geo-api-vision-combined_zh.md`

Problems:

- The nested `geoscratch-geo-api-vision-docs/` directory is awkward as the canonical path.
- The combined document duplicates the modular docs and can drift.
- The docs are Chinese-only, while the scratch vision docs are modular bilingual docs.
- `AGENTS.md` currently routes future agents to the scratch vision docs, but not to this geo API draft.

Future work:

- Move the module index to `docs/vision/geo-api/README_zh.md`.
- Add English `README.md` counterparts when the geo API becomes active work.
- Keep numbered modules directly under `docs/vision/geo-api/`.
- Remove the combined document, or mark it as generated and document how it is produced.
- Update `AGENTS.md` so future geo-layer work reads this review note and the geo API vision docs.

### 2. Patch And Plan Contracts Are Not Closed

The draft correctly makes `GeoVizDocument` the canonical state, but the patch operation set does not yet cover every canonical document field.

Examples of gaps:

- `schemas`
- `styles` lifecycle operations
- `portrayal`
- `constraints`
- `render`
- `diagnostics`
- `extensions`
- source property updates beyond add/remove

There is also type drift between the `GeoPatchPlan` shape in the document/IR module and the plan/patch/migration module. One version uses `diagnostics: GeoDiagnostic[]` and `rollback?: RollbackToken`; another uses `diagnostics: GeoDiagnosticReport`, `version`, `targetRevision`, `cost`, `suggestedPatches`, and `rollbackToken`.

Future work:

- Define one authoritative `GeoVizPatch`, `GeoVizPatchOperation`, `GeoPatchPlan`, `ApplyResult`, and rollback contract.
- Decide whether semantic patch operations are exhaustive, or whether there is a controlled generic `set-document-property` fallback.
- Require every mutating convenience API to lower into the same patch/plan/apply flow.
- Make plan output stable enough for tests and agent tooling.

### 3. Diagnostic Contracts Need A Central Schema

The docs repeatedly reference `GeoDiagnostic`, `GeoDiagnosticReport`, `GeoDiagnosticSubject`, and `GeoDiagnosticSuggestion`, but there is no single authoritative diagnostic schema.

This is a serious issue for the "AI-friendly" goal, because agent workflows need stable machine-readable diagnostics:

- code
- severity
- phase
- subject
- expected
- actual
- evidence
- suggestions
- suggested patch
- related resources
- security/privacy redaction state

Future work:

- Add a dedicated diagnostics module or fold an authoritative schema into the agent/tools module.
- Align the shape with the scratch diagnostic envelope where possible.
- Define stable error-code naming and versioning rules.
- Require all validation, planning, profiling, repro, and agent-tool failures to use the same envelope.

### 4. RenderGraph To Scratch Submission Needs A Clearer Lowering Boundary

The draft correctly says `geo` RenderGraph is above scratch and should not become magic sorting. However, the current `RenderPassNode` shape includes `render`, `compute`, `copy`, `upload`, `readback`, and `custom`, while `ScratchSubmissionPlan` is mostly expressed in terms of pass specs and commands.

That risks reintroducing ambiguity already avoided in the scratch design: not every submission step is a render/compute pass.

Future work:

- Model graph lowering as ordered `SubmissionStep`s, not only pass nodes.
- Distinguish render/compute pass steps from transfer, upload, copy, query resolve, and readback steps.
- Keep automatic ordering as a geo-level planning feature, while scratch remains explicit about submitted order and dependency validation.
- Clarify that terms such as `frame` in geo docs mean application/presentation frame, not a scratch-core frame abstraction.

### 5. Schema, Units, Semantics, And Expressions Need Extension Registries

The current `FieldSchema.semantic` and `FieldSchema.unit` unions are useful examples, but too small to be the long-term contract for GIS, remote sensing, nautical charts, simulations, domain datasets, and business geospatial overlays.

Likewise, the expression IR is correctly analyzable, but operators such as `case`, `match`, and `interpolate` need a formal grammar and schema before implementation.

Future work:

- Treat built-in semantics and units as a registry, not as a closed enum.
- Support namespaced/custom semantics and units with validation metadata.
- Define how schema confidence, profiling evidence, unknown nullability, and tentative inference are represented.
- Formalize expression grammar, type checking, dependency extraction, GPU lowering, and unsupported-expression diagnostics.

### 6. Material Terminology Needs Guardrails

The top-level geo draft allows `Material` as an optional surface-rendering helper for glTF-like mesh or terrain surface appearance, while the overview rejects `Material` as a general geospatial rendering abstraction.

That distinction is reasonable, but the word is risky because the repository has already decided that material-like scene concepts must not enter scratch core, and they should not become the default mental model for geo either.

Future work:

- Prefer narrower terms such as `SurfaceAppearance`, `MeshAppearance`, or `TerrainAppearance` if this helper becomes necessary.
- Keep style, symbolizer, portrayal, and layer as the general geo abstractions.
- Ensure any material-like helper lowers into explicit scratch `Program`, `BindSet`, `Pipeline`, and `Command` primitives.

### 7. Security Defaults Need To Be Explicit

The security and repro docs point in the right direction, especially around credential policy, network policy, export policy, and redaction. However, defaults should be explicit before the API becomes active implementation work.

Future work:

- Make literal tokens disallowed by default.
- Make local-file and localhost access opt-in for agent tools.
- Define how repro capsules redact sensitive fields, credentials, URLs, and source samples.
- Ensure explain/profile outputs obey field security labels by default.

### 8. Generated Or Local Files Should Stay Out Of Review Scope

The working tree currently also contains a `.gitignore` change unrelated to geo API architecture:

- add `dist/`
- add `*.bin`

This may be reasonable, but it is not part of the geo API design review itself.

Future work:

- Commit unrelated ignore-rule changes separately, or justify them in the PR body.
- Keep geo API documentation changes scoped to `docs/vision/geo-api/` unless there is a deliberate repository-policy update.

## Suggested Later Sequence

When the project returns to `geo-api`, handle the cleanup in this order:

1. Normalize the docs tree and source-of-truth layout.
2. Add bilingual index/module docs if the geo API vision is becoming canonical.
3. Update `AGENTS.md` routing for geo-layer architecture work.
4. Define authoritative `GeoDiagnosticReport`.
5. Unify `GeoVizPatch`, `GeoPatchPlan`, `ApplyResult`, and rollback contracts.
6. Clarify RenderGraph lowering into scratch submission steps.
7. Convert schema semantics, units, and expression functions into extensible registries.
8. Add one end-to-end minimal example: `GeoVizDocument` -> source/schema -> style plan -> render graph plan -> scratch submission plan -> explain/profile/repro output.

## Current Decision

Do not implement the above cleanup now.

The review is preserved so the repository can return to it later without losing context. The immediate priority remains the `scratch` implementation and its WebGPU execution-kernel API.
