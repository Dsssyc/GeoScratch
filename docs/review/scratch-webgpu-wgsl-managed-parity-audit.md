# Scratch WebGPU/WGSL Managed Parity Audit

## Status

Phase 1 runtime and attempt-local texture parity is complete on
`socu/scratch-webgpu-wgsl-parity-v1`, based on
`e905b33e7bd8fdc68e9400ffe103a52e89c21488`. This living audit records the
fixed specification surface and will be finalized only after all seven
WebGPU families, the scoped WGSL layout family, consumer migration, full
gates, and the single independent review are complete.

## Frozen Specification Baseline

| Source | Revision | Reproducible fact |
| --- | --- | --- |
| WebGPU | W3C CRD, 14 July 2026 | SHA-256 `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30` |
| WGSL | W3C CRD, 16 July 2026 | SHA-256 `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa` |
| GPUWeb editor source | `gpuweb/gpuweb` | `99d2ded3335433260fd756abacc2d2b280999b8d` |
| Declaration repository | `gpuweb/types` | `9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30` |
| Installed declaration package | `@webgpu/types@0.1.71` | npm git head `acad56b8107ba88841b7753df5a8d7c27d33e916`; declaration SHA-256 `d2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3` |

The W3C snapshot bytes are not committed. Their URLs and hashes are fixed
above. Normal tests use the installed declaration file and checked-in compact
manifests and never access the network.

Official sources:

- https://www.w3.org/TR/2026/CRD-webgpu-20260714/
- https://www.w3.org/TR/2026/CRD-WGSL-20260716/
- https://github.com/gpuweb/gpuweb/commit/99d2ded3335433260fd756abacc2d2b280999b8d
- https://github.com/gpuweb/types/commit/9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30

## Capability Manifests

| Manifest | Entries | Baseline classification |
| --- | ---: | --- |
| `docs/review/manifests/scratch-webgpu-2026-07-14.json` | 591 | 315 first-class; 170 semantic equivalent; 53 target gaps; 53 not applicable; 0 newly discovered |
| `docs/review/manifests/scratch-wgsl-2026-07-16.json` | 65 | 14 first-class; 17 semantic equivalent; 33 target gaps; 1 not applicable; 0 newly discovered |

The WebGPU manifest classifies every GPU-prefixed interface, direct member,
and type alias in the fixed declarations, including merged overloads and
types-package compatibility helpers. The WGSL manifest classifies all 12
language extensions, every scalar/vector/matrix host layout in scope,
recursive/runtime/atomic/buffer layout families, and shader-only type domains.

`node tests/audits/scratch-webgpu-wgsl-managed-parity.mjs` regenerates both
manifests, verifies every entry has one allowed classification, rejects
unassigned/new gaps, and emits structured native-call, public-export, and old
surface inventories.

## Target Status Matrix

| Capability family | Frozen baseline | Current status |
| --- | --- | --- |
| GPUExternalTexture | Native import, external bind slots, temporal expiry | Phase 1 implemented; ADR-049 Accepted |
| RenderBundle/debug commands | Native bundle encode/execute and encoder debug mixin | Known target gap; ADR-051 Proposed |
| ShaderModule/Program decomposition | Reusable modules, separate stages, auto-derived layouts | Known target gap; ADR-050 Proposed |
| Optional fragment | Native fragment omission and no-color-output depth/stencil | Known target gap; ADR-050 Proposed |
| SurfaceTextureLease | Managed current-texture attachment/copy/binding use | Phase 1 implemented; ADR-049 Accepted |
| Runtime adapter/device parity | feature level, XR request, default queue, immutable adapter facts | Phase 1 implemented |
| Texture transfer completeness | upload aspect, direct texture readback, mapped lease | Known target gap; ADR-052 Proposed |
| WGSL type/layout semantics | Recursive host-shareable ABI and buffer views | Known target gap; ADR-053 Proposed |

## Phase 0 Inventory

The initial structured audit finds 69 selected native WebGPU call sites under
Scratch, 268 exports from the Scratch entrypoint, and 359 exports from the
package entrypoint. It confirms that the old `ProgramDescriptor.modules`
surface is still present at the baseline. These are inventory facts, not
completion claims; Phase 2 must remove the old surface and the final audit
must classify every changed call and export.

## Phase 1 Checkpoint

Phase 1 adds immutable Runtime request facts for adapter/device/queue options,
partial-or-absent adapter information, external-texture layout and binding
support, and one submission-owned `AttemptTextureAuthority` shared by external
imports and current Surface textures. A `SurfaceTextureLease` can be used by
render/resolve attachments, all native texture copy directions that accept a
texture endpoint, ordinary sampled/storage bindings, and external-texture slots.
The former public `Surface.getCurrentTexture()` bypass is removed.

Attempt-local values never become `Resource` instances or persistent prepared
bind groups. Selected uses are validated before encoder creation, realized once
per submission attempt, observed under the selected command or attachment
location, and expired when the attempt closes. Synchronous import, acquisition,
view, and bind-group failures use stable structured diagnostics; delayed native
outcomes retain the existing `SubmittedWork` ownership model.

Checkpoint evidence:

- `npm test`: 1063 passing and 2 expected pending;
- `npm run typecheck`: passed;
- `npm run build`: passed for the package and all 17 examples;
- `node tests/audits/scratch-webgpu-wgsl-managed-parity.mjs`: passed with 70
  current native call sites, 283 Scratch exports, and 374 package exports;
- submission native provenance inventory: 51/51 current source call sites
  classified; and
- `tests/scratch-temporal-texture.test.js`: 17/17 focused attempt-local tests,
  including the no-Surface-inspection-after-encoder regression.

The frozen manifests retain their baseline classifications. Their target-gap
labels describe the goal-start snapshot and are not rewritten phase by phase;
the living matrix above records current implementation status.

## Required Final Matrices

Before completion, this document will contain:

- final native call-site ownership and attribution;
- final public API and both-entrypoint export parity;
- diagnostics schema and bounded-retention results;
- browser capability/support/skip/result facts;
- every current example build and regression result;
- Flow, DEM, and Hello GAW headed regression results;
- stress end-state counters;
- exactly one independent review and its findings;
- at most one concentrated correction result; and
- final sequential gate commands and results.

## Review And Completion

Independent review count: 0.

Correction count: 0.

Final result: not yet assessed. Rendering examples alone is not sufficient
evidence for either `clean` or `issues-found`.
