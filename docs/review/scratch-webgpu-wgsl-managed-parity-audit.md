# Scratch WebGPU/WGSL Managed Parity Audit

## Status

Phase 5 recursive WGSL layout parity is complete through
`socu/scratch-webgpu-wgsl-parity-v1`, based on
`e905b33e7bd8fdc68e9400ffe103a52e89c21488`. This living audit records the
fixed specification surface. All seven selected WebGPU families and the
scoped WGSL layout family are now implemented. The audit will be finalized
only after Phase 6 consumer/browser regression, final sequential gates, and
the single Phase 7 independent review are complete.

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
| RenderBundle/debug commands | Native bundle encode/execute and encoder debug mixin | Phase 3 implemented; ADR-051 Accepted |
| ShaderModule/Program decomposition | Reusable modules, separate stages, auto-derived layouts | Phase 2 implemented; ADR-050 Accepted |
| Optional fragment | Native fragment omission and no-color-output depth/stencil | Phase 2 implemented; ADR-050 Accepted |
| SurfaceTextureLease | Managed current-texture attachment/copy/binding use | Phase 1 implemented; ADR-049 Accepted |
| Runtime adapter/device parity | feature level, XR request, default queue, immutable adapter facts | Phase 1 implemented |
| Texture transfer completeness | upload aspect, direct texture readback, mapped lease | Phase 4 implemented; ADR-052 Accepted |
| WGSL type/layout semantics | Recursive host-shareable ABI and buffer views | Phase 5 implemented; ADR-053 Accepted |

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

## Phase 2 Checkpoint

Phase 2 clean-cut the old joined `Program.modules` model. `ShaderModule` now
owns acknowledged native compilation, ordered source-part hashes and mapping,
compilation hints, and bounded source-free reports. Program stages reference
one acknowledged module each, so render pipelines can use distinct vertex and
fragment modules and multiple pipelines can reuse one native module.

Pipeline layout mode is explicitly `explicit` or `auto`. Auto-layout pipelines
can acknowledge native-derived BindLayouts through `getBindLayout()`, while
explicit layouts remain the omission default. Fragment is optional; omitting
it also omits the native fragment descriptor and supports no-color-output
depth/stencil work. The removed modules, pipeline-owned source, entry-point
aliases, and top-level bind-layout aliases have no compatibility overload.

Checkpoint commit: `6aa8790` (`Decompose Scratch shader modules and
pipelines`). ADR-050 is Accepted.

## Phase 3 Checkpoint

Phase 3 adds closed `BundleDrawCommand`, `RenderBundle`,
`ExecuteRenderBundlesCommand`, and `DebugCommand` public contracts. Persistent
bundles acknowledge one native creation operation and retain allocation,
BindSet preparation, and immediate-data snapshots. Attempt-local bundles use
the submission-owned temporal authority and realize at most once per authored
bundle per attempt. Stale persistent dependencies fail without hidden repair.

Bundle/pass compatibility covers color formats with trailing-null equality,
depth/stencil format, sample count, read-only constraints, fragmentless
depth-only work, and the cull-aware native stencil-write rule. Native
`executeBundles()` is issued even for an empty sequence; following Draws
re-emit complete state. Nested resource writes advance once per successful
bundle occurrence and appear in immutable SubmittedWork access and bundle
facts.

One DebugCommand family lowers to command, render-pass, compute-pass, and
render-bundle encoders. Groups balance inside their exact encoder scope and
cannot cross an upload-created command-encoder boundary. Diagnostic labels,
open-stack evidence, operation history, and stress reuse remain bounded.
Synchronous failures and delayed native outcomes remain attributed to the
owning command, submission, or persistent bundle operation.

Checkpoint evidence:

- `tests/scratch-render-bundle-debug.test.js`: 27/27 passing;
- `npm test`: 1087 passing and 2 expected pending;
- `npm run typecheck`: passed for package, public API, examples, and canonical
  WebGPU declarations;
- `npm run build`: passed for the package and all 17 examples;
- `git diff --check`: passed;
- structured parity audit: passed with 79 selected native calls, 311 Scratch exports, and
  402 package exports, with the RenderBundle/debug checks passed; and
- submission native provenance inventory: 58/58 current source call sites
  classified.

ADR-051 is Accepted. Consolidated headed browser execution remains a Phase 6
gate and is not claimed by this checkpoint.

## Phase 4 Checkpoint

Phase 4 extends the single `TextureUploadCommand` queue-write path with explicit
aspect selection and format-aware copy footprints. Direct texture readback
captures the selected allocation version and content epoch, emits one native
texture-to-buffer copy with 256-byte staging rows, and exposes a separate tight
logical row layout to host consumers. Color, depth, stencil, and compressed
formats follow their physical texel-block and full-subresource constraints.

`ReadbackOperation.map()` now returns a one-owner `MappedReadbackLease` over the
native staging range without creating an owned host copy. Releasing, cancelling,
disposing, Runtime disposal, and device loss invalidate the mapped view and
retire staging ownership. Direct buffer and texture readbacks share the same
bounded staging, mapping, native-outcome, and diagnostic authority. Ordered
`ReadbackCommand` remains buffer-only and compositionally matches explicit
texture-to-buffer copy followed by buffer readback.

Checkpoint evidence:

- `tests/scratch-texture-transfer-readback.test.js`: 19/19 passing;
- `npm test`: 1106 passing and 2 expected pending;
- `npm run typecheck`: passed for package, public API, examples, and canonical
  WebGPU declarations;
- `npm run build`: passed for the package and all 17 examples;
- structured parity audit: passed with 80 selected native calls, 319 Scratch
  exports, and 410 package exports, including all texture-transfer checks;
- submission native provenance inventory: 59/59 current source call sites
  classified; and
- `node tests/stress/scratch-readback-staging-mapping.mjs`: passed with 20,000
  direct operations, 5,000 ordered reuses, and 5,000 direct texture mapped
  leases. Terminal pending operations, mappings, staging bytes, and lifecycle
  subscribers were all zero.

ADR-052 is Accepted. Consolidated headed browser execution remains a Phase 6
gate and is not claimed by this checkpoint.

## Phase 5 Checkpoint

Phase 5 replaces the former flat primitive layout surface with one recursive
host-layout model. It covers every scoped scalar, vector, and floating matrix
shape; exact binary16 packing; recursive fixed arrays and structures;
final-member runtime arrays; storage atomics; explicit member `@align` /
`@size`; and opaque `buffer<N>` / runtime `buffer` roots. Public TypeScript
descriptors encode fixed-footprint nesting and final-runtime-member grammar,
while runtime validation retains the same fail-closed rules for JavaScript and
dynamic input.

`FixedLayoutArtifact` and `RuntimeLayoutArtifact` are distinct public facts.
Only fixed artifacts expose a total byte length and stride. Runtime artifacts
retain a fixed prefix, minimum binding size, runtime-tail or byte-granularity
facts, and require an explicit element count for concrete host ranges. ABI and
schema identity cover recursive layout and capability contracts. Every usage
compatibility result reports reasons plus required device/language features;
`shader-f16`, `uniform_buffer_standard_layout`, and
`immediate_address_space` are derived rather than implied.

`LayoutBufferViewContract` models `bufferView`, `bufferArrayView`, and
`bufferLength` with explicit byte ranges, alignment, source/target layout,
address/access mode, and pointer provenance. Function-parameter chains derive
`unrestricted_pointer_parameters`; all buffer views derive `buffer_view`.
Program requirements carry these contracts into pipeline minimum binding size
and command-time exact range validation. Generated constants never hide the
dynamic byte range, and Program remains the authority for caller-authored WGSL
directives, overrides, and dynamic values.

Checkpoint evidence:

- recursive LayoutCodec, readback, and Program focused tests: 50/50 passing;
- `npm test`: 1120 passing and 2 expected pending;
- `npm run typecheck`: passed for package, public API, all examples, and
  canonical WebGPU declarations;
- structured parity audit: passed with 80 selected native calls, 392 Scratch
  exports, and 483 package exports; its TypeScript-AST Phase 5 inventory
  confirms recursive declarations, codec operations, Program buffer-view
  contracts, both-entrypoint exports, and removal of `LayoutPrimitiveType`;
- persistent-binding structural parity audit: passed with the fixed/runtime
  and capability-contract documentation checks;
- `node tests/stress/scratch-layout-codec.mjs`: passed 20,000 recursive
  fixed/runtime cycles with 3,360,000 packed bytes, 3,141,584 bytes peak heap
  growth against a 128 MiB bound, and zero terminal handles, mappings, staging
  bytes, pending operations, or retained native handles; and
- ADR-053 is Accepted and the English/Chinese resource, Program/codec, and
  diagnostic modules describe the implemented model.

The frozen WGSL manifest intentionally retains its goal-start
`known-target-gap` classifications. The living matrix and checkpoint describe
the current implementation; silently rewriting the frozen baseline would
erase the evidence of what this goal closed. Consolidated browser shader
proofs for nested matrices, `f16` when supported, and `buffer_view` when
supported remain a Phase 6 gate and are not claimed here.

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
