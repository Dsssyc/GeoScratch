# Scratch WebGPU/WGSL Managed Parity Audit

## Status

Phase 6/7 evidence closure is complete on
`socu/scratch-webgpu-wgsl-evidence-closure-v1`, based on
`f8d82ebfce1ab324d95d8d59acf654cda16ee28d`. The frozen Phase 0 manifests
remain unchanged. A separate current-state manifest now closes all 662
formal entries with explicit, fail-closed evidence rules: 591 WebGPU entries,
65 previously scoped WGSL entries, and six formal WGSL `enable` extensions.

The final acceptance gate is bound to the clean correction commit containing
this audit. Its result is `clean` only when every command in the final gate
table exits zero. A non-zero result changes the terminal Goal result to
`issues-found`; it does not authorize another implementation, review, or
browser-test cycle.

## Frozen Specification Baseline

| Source | Revision | Reproducible fact |
| --- | --- | --- |
| WebGPU | W3C CRD, 14 July 2026 | SHA-256 `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30` |
| WGSL | W3C CRD, 16 July 2026 | SHA-256 `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa` |
| GPUWeb editor source at frozen baseline | `gpuweb/gpuweb` | `99d2ded3335433260fd756abacc2d2b280999b8d` |
| GPUWeb editor source at one-time refresh | `gpuweb/gpuweb` | `b33e6efb182d11156851271586563cc77575059c` |
| Declaration repository | `gpuweb/types` | `9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30` |
| Installed declaration package | `@webgpu/types@0.1.71` | npm git head `acad56b8107ba88841b7753df5a8d7c27d33e916`; declaration SHA-256 `d2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3` |
| Proposal index at one-time refresh | `gpuweb/gpuweb` proposals | README SHA-256 `25d168b6796672bb1037933cddc31468fd10f7b7aa2f2196b7681d9f20213018` |

The W3C snapshot bytes are not committed. Their URLs and hashes are fixed
above. Normal tests use the installed declaration file and checked-in compact
manifests and never access the network.

Official sources:

- https://www.w3.org/TR/2026/CRD-webgpu-20260714/
- https://www.w3.org/TR/2026/CRD-WGSL-20260716/
- https://github.com/gpuweb/gpuweb/commit/99d2ded3335433260fd756abacc2d2b280999b8d
- https://github.com/gpuweb/gpuweb/commit/b33e6efb182d11156851271586563cc77575059c
- https://github.com/gpuweb/types/commit/9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30
- https://github.com/gpuweb/gpuweb/tree/b33e6efb182d11156851271586563cc77575059c/proposals

The one-time refresh was observed on 24 July 2026. The only editor delta from
the frozen commit was `[bindless] Rename insert/removeBinding to
insert/remove (#6341)`, scoped to a non-normative draft proposal. It created
no formal WebGPU/WGSL delta and did not expand this Goal. Draft proposals
remain watchlist-only.

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

## Current Coverage Closure

The historical manifests above remain frozen evidence of the goal-start
state. The current-state manifests are:

| Manifest | Entries | Current result |
| --- | ---: | --- |
| `docs/review/manifests/scratch-webgpu-wgsl-current-coverage.json` | 662 | 608 managed; 54 not applicable; 0 unresolved |
| `docs/review/manifests/scratch-wgsl-enable-extensions-2026-07-16.json` | 6 | six contracts; one formal dependency |

The 608 managed entries comprise 415 `managed-first-class` and 193
`managed-semantic-equivalent` entries. The 54 `not-applicable` entries are
WebIDL domains or declaration helpers with entry-specific reasons; none are
used to hide a native capability. Every managed entry has an explicit
coverage rule, public expression path or caller-authored WGSL contract,
located native or compiler path, structured capability requirements, and one
or more bounded evidence IDs. There is no catch-all fallback and no
`runtime.device` or `runtime.queue` escape-hatch classification.

`node tests/audits/scratch-webgpu-wgsl-current-coverage.mjs` regenerates both
current manifests and rejects:

- an unmatched entry or fallback coverage rule;
- missing, unused, unresolved, or unlocatable evidence;
- a native operation absent from the named source path;
- a named public symbol absent from the TypeScript export graph;
- raw-device or raw-queue laundering;
- an unexplained `not-applicable` result;
- a missing feature, language-feature, limit, or dependency condition;
- a mixed WGSL `enable` and `requires` capability contract; and
- an incomplete browser proof set or public-entrypoint mismatch.

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

## WGSL Capability Contracts

Caller-authored WGSL remains the language surface. Scratch does not parse
shader text to infer capabilities and does not add an implicit
`requiredEnableExtensions` API. Runtime and Program independently require the
same explicit device features, while `requiredLanguageFeatures` represents
WGSL `requires` extensions. The six formal `enable` contracts are:

| `enable` extension | Runtime/Program device features | Final Chrome result |
| --- | --- | --- |
| `clip_distances` | `clip-distances` | passed |
| `dual_source_blending` | `dual-source-blending` | passed |
| `f16` | `shader-f16` | passed with recursive `f16` matrix packing/readback |
| `primitive_index` | `primitive-index` | passed |
| `subgroup_size_control` | `subgroup-size-control`, `subgroups` | skipped: adapter omitted `subgroup-size-control` |
| `subgroups` | `subgroups` | passed |

`subgroup-size-control` has one formal dependency on `subgroups`. Shared
Runtime/Program preflight rejects the missing dependency before native device
or pipeline creation, never auto-injects it, and reports
`SCRATCH_RUNTIME_REQUEST_INVALID` or
`SCRATCH_PROGRAM_FEATURE_DEPENDENCY_MISSING` through the structured
diagnostic envelope.

The browser matrix performs semantic execution for every advertised language
feature. A source containing only `requires` is not accepted as evidence.

| WGSL language feature | Final Chrome result | Executed semantic |
| --- | --- | --- |
| `readonly_and_readwrite_storage_textures` | passed | read/write `r32uint` storage texture and buffer readback |
| `packed_4x8_integer_dot_product` | passed | `dot4U8Packed` result readback |
| `unrestricted_pointer_parameters` | passed | storage pointer function parameter writes output |
| `pointer_composite_access` | passed | vector-component pointer dereference |
| `uniform_buffer_standard_layout` | passed | tightly packed uniform array through LayoutCodec |
| `subgroup_id` | passed | subgroup built-ins affect readback |
| `subgroup_uniformity` | passed | subgroup diagnostic and operation affect readback |
| `texture_and_sampler_let` | passed | local texture/sampler handles drive sampling |
| `texture_formats_tier1` | skipped | browser omitted the WGSL language feature |
| `linear_indexing` | passed | `global_invocation_index` affects readback |
| `immediate_address_space` | passed | per-command immediate value readback |
| `buffer_view` | skipped | browser omitted the WGSL language feature |

The same matrix separately executes nested `mat3x2f` layout readback. The
final matrix therefore contains 19 unique proofs: 16 passed, three skipped,
and zero failed. Every executed proof creates a real Scratch Runtime,
ShaderModule, Program, pipeline, submission, and GPU readback. All use the
same `high-performance` adapter selection facts; all executed terminals have
zero live resources, mappings, readbacks, pending native observations,
uncaptured errors, device losses, validation errors, internal errors, and OOM
errors.

The headed environment is Chrome `150.0.7871.184`. The three skips are
capability facts, not fallbacks: the adapter omitted
`subgroup-size-control`, while
`navigator.gpu.wgslLanguageFeatures` omitted `texture_formats_tier1` and
`buffer_view`. In particular, advertising the device feature
`texture-formats-tier1` does not substitute for the missing WGSL language
feature.

## Public And Native Parity

The current coverage audit resolves 152 runtime values from both
`geoscratch` and `geoscratch/scratch` with exact key parity. The package
TypeScript entrypoint exposes 483 source declaration exports, and the
compatibility shim is a pure `export * from './index.js'`. Required public
symbols for Runtime, resources, bindings, ShaderModule/Program, pipelines,
commands, submissions, readback, bundles, and LayoutCodec are present through
both entrypoints.

The frozen structured parity audit classifies 80 selected Scratch native call
sites and reports 392 Scratch declarations plus 483 package declarations.
The current audit additionally requires every evidence-native operation to
occur in its named TypeScript source path. Native calls remain owned by
Runtime/resource/supporting-object creation, command encoding, submission,
readback, or temporal-attempt authorities. Removed joined Program modules and
old texture/readback bypasses remain absent. No current managed entry cites
raw `GPUDevice` or `GPUQueue` access as its expression path.

## Diagnostics And Bounds

All new failure paths use `ScratchDiagnostic`. Capability dependencies,
adapter/device requests, Program contracts, shader compilation,
pipeline creation, submissions, readback, uncaptured errors, OOM, and device
loss retain stable attribution. Evidence storage remains bounded rather than
acting as an unbounded frame log.

| Stress proof | Work completed | Terminal/bound result |
| --- | --- | --- |
| Buffer mapping | 20,000 ordinary leases; 5,000 mapped creations | zero mappings, selected bytes, pending operations, resources, and lifecycle subscribers |
| Current-content reads | 20,000 submissions | 64 retained operations, zero incidents/pending operations, bounded heap |
| Recursive LayoutCodec | 20,000 cycles; 3,360,000 packed bytes | zero handles, mappings, staging bytes, pending operations, and retained native handles |
| Persistent bindings | 20,000 + 20,000 steady-state cycles | zero identity changes; zero pending operations and command encoders |
| Readback | 20,000 direct; 5,000 ordered; 5,000 texture leases | zero readbacks, mappings, staging/host bytes, pending operations, and lifecycle subscribers |
| Submission provenance | 20,000 summary; 20,000 off | zero pending observations, effectful submitted work, lifecycle subscribers, and unhandled rejections |

The inherited persistent-binding structural audit exits zero while retaining
its deliberate `verification.status: incomplete`; this is historical
structural-mode metadata and does not start another review cycle.

## Consumer And Browser Regression

`npm run build` builds the package and all 17 ordinary examples. The example
inventory contains zero legacy examples. The headed Chrome regressions pass:

| Regression | Result |
| --- | --- |
| Flow Layer | passed, including estuary display boundary and terminal disposal |
| DEM Layer | passed |
| Hello GAW | passed, including rendered output and provenance |
| Hello GAW initialization failures | passed, including attributed injected/native failures and cleanup |

No Flow, DEM, or Hello GAW visual parameters, resource extents, or business
behavior were changed by this evidence-closure Goal.

## Initial Gate

The one complete initial gate ran all 18 required commands. Seventeen passed.
`npm test` alone failed with 1126 passing and two expected pending tests
because one structural snapshot still expected 107 emitted JavaScript and
declaration files after the new source file raised both counts to 108. The
failure was bookkeeping, not a runtime or API regression, and became part of
the single correction batch.

Two earlier shell-wrapper drafts failed before starting any gate command and
left zero-byte command logs. They are launcher setup failures, not additional
full gates or browser retries.

## Independent Review

Independent fresh-context review count: 1.

The reviewer reported `issues-found` before correction:

| Material finding | Single correction |
| --- | --- |
| Catch-all/self-certifying current-manifest mappings, including wrong mappings for discovery, immediate data, and public symbols | Replaced with explicit fail-closed coverage rules, exact exported symbols, located native operations, and no fallback |
| Missing feature/language/limit conditions for conditional WebGPU domains | Added structured conditions for depth clipping, timestamps, swizzle, immediate data, dual-source blending, indirect first instance, compressed/storage/float texture formats, and tier dependencies |
| Language proofs merely declared `requires` while executing unrelated constants | Replaced with feature-specific shaders whose semantics determine GPU readback |
| Capability discovery and proof runtimes could select different adapters, and incomplete proof rows could pass validation | Discovery now uses ScratchRuntime with the same power preference; validator requires the exact 19-row set, adapter facts, contracts, execution evidence, and clean terminals |
| Final provenance, gate, and audit record were incomplete | Pinned source URLs/commits/hashes and completed this living audit |

The reviewer also identified the stale 107/107 emitted-file snapshot. It is
updated to 108/108, 4,623 declaration signatures, and 216 emitted files.

Correction count: 1. No second reviewer or second correction batch was used.
After correction, focused manifest tests, the structural emitted-output test,
package build, and the strengthened current-coverage audit passed before the
single final full gate.

## Final Gate

The final gate targets the clean correction commit containing every reviewed
byte. Commands run once, sequentially, in this exact order:

| Command | Result |
| --- | --- |
| `git diff --check` | passed |
| `npm test` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `node tests/audits/scratch-webgpu-wgsl-managed-parity.mjs` | passed |
| `node tests/audits/scratch-webgpu-wgsl-current-coverage.mjs` | passed |
| `node tests/audits/scratch-persistent-binding-views-final-parity.mjs` | passed with expected structural `incomplete` metadata |
| `node tests/stress/scratch-buffer-mapping.mjs` | passed |
| `node tests/stress/scratch-current-content-reads.mjs` | passed |
| `node tests/stress/scratch-layout-codec.mjs` | passed |
| `node tests/stress/scratch-persistent-binding-views.mjs` | passed |
| `node tests/stress/scratch-readback-staging-mapping.mjs` | passed |
| `node tests/stress/scratch-submission-native-provenance.mjs` | passed |
| `node tests/browser/scratch-wgsl-capability-matrix.mjs` | passed: 16 pass, 3 capability skips, 0 fail |
| `node tests/browser/scratch-flow-layer.mjs` | passed |
| `node tests/browser/scratch-dem-layer.mjs` | passed |
| `node tests/browser/scratch-hello-gaw.mjs` | passed |
| `node tests/browser/scratch-hello-gaw-init-failures.mjs` | passed |

## Completion

Final result: `clean`.

The current formal baseline has no unclassified editor delta, all 662 entries
have machine-resolvable evidence, `unresolved` is zero, all formal capabilities
have a managed Scratch or explicit caller-WGSL path, and no capability depends
on raw device/queue access. Supported browser paths execute successfully;
unsupported paths carry exact capability facts. The only independent review's
material findings are closed by the one allowed correction, all required
gates pass, and the final worktree is clean.
