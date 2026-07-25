# Scratch WebGPU/WGSL Managed Parity Audit

## Status

Phase 6/7 fixed-convergence work is complete on
`socu/scratch-webgpu-wgsl-evidence-closure-v1`, based on
`f8d82ebfce1ab324d95d8d59acf654cda16ee28d`. The frozen Phase 0 manifests
remain unchanged. A separate current-state manifest classifies all 662 formal
entries with explicit, fail-closed evidence rules: 591 WebGPU entries, 65
previously scoped WGSL entries, and six formal WGSL `enable` extensions.
The original Phase 6/7 browser gate found two invalid language-feature proof
shaders, so that Goal terminated `issues-found` rather than claiming complete
evidence closure. The bounded pointer-proof follow-up recorded at the end of
this audit closes both defects on base
`8d7923840dac33e6e9d372450d8f3c98ef10e50c` and terminates `clean`; the
historical Phase 6/7 result remains unchanged below.

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
| `unrestricted_pointer_parameters` | failed | proof parameter name `target` is a reserved WGSL keyword |
| `pointer_composite_access` | failed | proof attempts to take the address of a vector component, which native validation rejects |
| `uniform_buffer_standard_layout` | passed | tightly packed uniform array through LayoutCodec |
| `subgroup_id` | passed | subgroup built-ins affect readback |
| `subgroup_uniformity` | passed | subgroup diagnostic and operation affect readback |
| `texture_and_sampler_let` | passed | local texture/sampler handles drive sampling |
| `texture_formats_tier1` | skipped | browser omitted the WGSL language feature |
| `linear_indexing` | passed | `global_invocation_index` affects readback |
| `immediate_address_space` | passed | per-command immediate value readback |
| `buffer_view` | skipped | browser omitted the WGSL language feature |

The same matrix separately executes nested `mat3x2f` layout readback. The
final matrix therefore contains 19 unique proofs: 14 passed, three skipped,
and two failed. Every successful proof creates a real Scratch Runtime,
ShaderModule, Program, pipeline, submission, and GPU readback. All use the
same `high-performance` adapter selection facts. The two failed proofs each
produce one captured validation error and no uncaptured error, device loss,
internal error, or OOM error. Every attempted proof, including both failures,
terminates with zero live resources, mappings, readbacks, pending operations,
and pending native observations.

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
| Language proofs merely declared `requires` while executing unrelated constants | Replaced with feature-specific shaders intended to determine GPU readback; the final native gate then exposed two invalid proof programs listed below |
| Capability discovery and proof runtimes could select different adapters, and incomplete proof rows could pass validation | Discovery now uses ScratchRuntime with the same power preference; validator requires the exact 19-row set, adapter facts, contracts, execution evidence, and clean terminals |
| Final provenance, gate, and audit record were incomplete | Pinned source URLs/commits/hashes and completed this living audit |

The reviewer also identified the stale 107/107 emitted-file snapshot. It is
updated to 108/108, 4,623 declaration signatures, and 216 emitted files.

Correction count: 1. No second reviewer or second correction batch was used.
After correction, focused manifest tests, the structural emitted-output test,
package build, and the strengthened current-coverage audit passed before the
single final full gate.

## Final Gate

The final gate targeted clean correction commit `6c0b20c`. Commands ran once,
sequentially, in this exact order. This terminal `issues-found` audit update
records their result after execution; it does not alter implementation or
authorize a gate rerun.

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
| `node tests/browser/scratch-wgsl-capability-matrix.mjs` | failed: 14 pass, 3 capability skips, 2 invalid shader proofs |
| `node tests/browser/scratch-flow-layer.mjs` | passed |
| `node tests/browser/scratch-dem-layer.mjs` | passed |
| `node tests/browser/scratch-hello-gaw.mjs` | passed |
| `node tests/browser/scratch-hello-gaw-init-failures.mjs` | passed |

## Completion

Final result: `issues-found`.

Seventeen of the 18 final commands pass. The current formal baseline has no
unclassified editor delta, all 662 entries have structurally resolvable
evidence, `unresolved` is zero, no expression path depends on raw
device/queue access, all six enable contracts behave as expected on the
available adapter, and all example and stress regressions pass. The final
capability matrix nevertheless prevents a `clean` conclusion:

1. `unrestricted_pointer_parameters` is advertised by
   `navigator.gpu.wgslLanguageFeatures`, but its proof fails at ShaderModule
   parsing because `target` at WGSL source line 8, column 5 is a reserved
   keyword. Scratch reports `SCRATCH_SHADER_MODULE_COMPILATION_FAILED`, one
   captured validation incident, exact ShaderModule attribution, and a clean
   terminal. This is a defect in the proof source, not evidence that the
   Scratch Program contract or managed path is missing.
2. `pointer_composite_access` is advertised, but its proof fails at WGSL
   source line 10, column 21 because it takes the address of a vector
   component. Scratch reports the same structured compilation diagnostic and
   clean terminal. The proof does not yet exercise the formal feature through
   a native-valid operation, so the current manifest's evidence claim is not
   browser-proven.

These defects remain because the Goal permits only one concentrated
correction followed by one final full gate. Fixing and rerunning them here
would violate the convergence contract. A bounded follow-up Goal should
change only the two pinned proof shaders: rename the reserved parameter,
replace the vector-component address expression with a
WGSL-CRD-conformant `pointer_composite_access` operation, add source-shape
unit assertions, and run one focused capability matrix plus the four existing
business regressions. It must not refresh the specification, alter Scratch
runtime/API code, or reopen the 662-entry classification unless a corrected
native-valid proof reveals an actual managed-path defect.

## Pointer Proof Follow-Up Closure

### Scope And Checkpoints

This follow-up is independent of the historical Phase 6/7 convergence cycle
above. It started from exact base
`8d7923840dac33e6e9d372450d8f3c98ef10e50c` on
`socu/scratch-wgsl-pointer-proof-closure-v1`. It made no Runtime, API,
manifest, vision, example, package, or specification-baseline change.

| Checkpoint | Commit |
| --- | --- |
| Goal base | `8d7923840dac33e6e9d372450d8f3c98ef10e50c` |
| Pointer proof implementation | `7e14ddcb92dc6777b9d7a63f065d2e951682e0dc` |
| Review correction and final-gate target | `ab3e0db23b058ba925629bfdbf3f13bb439ee0b6` |

The single source-shape RED first failed with both target facts false:
`unrestrictedPointer: false` and `pointerComposite: false`. The current
coverage audit independently failed only
`unrestrictedPointerProofSourceIsConformant` and
`pointerCompositeProofSourceIsConformant`; all 662 classifications remained
608 managed, 54 not applicable, and zero unresolved.

The implementation uses two native-valid WGSL CRD shapes:

- `unrestricted_pointer_parameters` passes a
  `ptr<storage, u32, read_write>` named `destination` into a function,
  dereferences it, and writes `103u` through `&outputValues`;
- `pointer_composite_access` takes a pointer to a complete local
  `array<u32, 4>`, indexes the array through that pointer, and writes the
  selected value `104u` to storage.

The focused source-shape test and current coverage audit then passed before
review.

### Independent Review And Correction

Fresh-context reviewer count: 1. The reviewer returned `issues-found` with
three material test-authority defects:

| Finding | Single correction |
| --- | --- |
| AST extraction ignored outer spreads and non-property members, so later runtime members could override the audited cases | Reject non-static `semanticCases` members and require each selected case to contain exactly static `source` and `expected` properties |
| TypeScript parse diagnostics were ignored, so a malformed source file could still yield a partial audit AST | Reject every parse diagnostic before extracting proof facts |
| The former pointer-fixture check did not prove that feature operations were executable AST statements | Require canonical complete WGSL programs and reject commented-out-operation fixtures |

The correction also rejects extra properties such as `expectedPredicate`,
outer spreads, malformed JavaScript, and direct constant writes disguised by
commented feature operations. Correction count: 1. No second reviewer or
second correction was used.

### Browser Proof Result

The headed matrix ran in Chrome `150.0.7871.184` with one
`high-performance` adapter selection. The adapter reported vendor `apple`,
architecture `metal-3`, subgroup range 32 to 32, and
`isFallbackAdapter: false`. It advertised both
`unrestricted_pointer_parameters` and `pointer_composite_access`.

Both target proofs produced zero compilation messages, created compute
pipelines, submitted with `observed-succeeded`, and completed GPU readback:

| Proof | Readback | Terminal |
| --- | ---: | --- |
| `unrestricted_pointer_parameters` | 103 | clean |
| `pointer_composite_access` | 104 | clean |

The complete matrix result is 19 proofs, 16 executed and passed, three
capability skips, and zero failures. The skips remain exact hardware/browser
facts: missing adapter feature `subgroup-size-control`, and missing WGSL
language features `texture_formats_tier1` and `buffer_view`. All executed
proofs terminated cleanly with zero captured validation, OOM, or native
failures; zero uncaptured errors; zero device losses; and no live resources,
mappings, readbacks, pending operations, or pending native observations.

### Final Focused Gate

The final gate targeted clean commit
`ab3e0db23b058ba925629bfdbf3f13bb439ee0b6`. Commands ran once, sequentially,
in the required order. No environment retry was used.

| Command | Result |
| --- | --- |
| `git diff --check` | passed |
| `npm test` | passed: 1131 passing, 2 expected pending |
| `npm run typecheck` | passed |
| `npm run build` | passed for the package and all 17 examples |
| `node tests/audits/scratch-webgpu-wgsl-managed-parity.mjs` | passed; frozen WebGPU/WGSL baselines unchanged |
| `node tests/audits/scratch-webgpu-wgsl-current-coverage.mjs` | passed: 662 entries, 608 managed, 54 not applicable, 0 unresolved |
| `node tests/browser/scratch-wgsl-capability-matrix.mjs` | passed: 16 pass, 3 capability skips, 0 failures |
| `node tests/browser/scratch-flow-layer.mjs` | passed: interaction, resize, estuary boundary, failure attribution, and terminal disposal |
| `node tests/browser/scratch-dem-layer.mjs` | passed: LOD/terrain execution, resize, failure attribution, and terminal disposal |
| `node tests/browser/scratch-hello-gaw.mjs` | passed: 240 frames, GPU-only indirect execution, provenance, resize, and bounded diagnostics |
| `node tests/browser/scratch-hello-gaw-init-failures.mjs` | passed: five attributed failure points and complete cleanup |

The stress results listed under `Diagnostics And Bounds` remain inherited
evidence from commit
`6c0b20c569f546e2fdb6dfcf01d2977bd53534a1`. This bounded follow-up did not
rerun them and does not claim new stress evidence.

### Follow-Up Completion

Follow-up result: `clean`.

Both previously invalid proof programs now exercise their advertised WGSL
features through native-valid operations and complete real Scratch
ShaderModule compilation, Program/pipeline creation, submission, GPU
readback, and clean disposal. The strengthened audit cannot be satisfied by
malformed JavaScript, property overrides, extra predicates, or commented-out
feature operations. The current 662-entry coverage facts remain unchanged,
all required final gates pass, and no corrected native proof exposed a
Scratch managed-path defect.

## Normative Inventory Drift Gate Follow-Up (2026-07-25)

This section supersedes the preceding 662-entry current-coverage authority
without rewriting that earlier audit as history. The frozen
`scratch-webgpu-2026-07-14.json` and `scratch-wgsl-2026-07-16.json`
manifests remain unchanged historical baselines. Living coverage now consumes
fixed, generated normative inventories for WebGPU, WGSL, capability
dependencies, and proposals.

### Fixed Source Observation

The single allowed online observation reached the WGSL publication plus the
pinned GPUWeb editor, `gpuweb/types`, and proposal metadata. The WebGPU
publication request returned a fetch error and was not retried. The checked
baseline records `status: partial`, `retryCount: 0`, and
`failedSource: W3C WebGPU publication page`.

The generated inventories were subsequently reproduced offline from the
already available GPUWeb checkout at
`b33e6efb182d11156851271586563cc77575059c` and the installed
`@webgpu/types` `0.1.71` declaration matching the fixed hash. This proves
deterministic extraction from the pinned inputs; it does not rewrite the
incomplete one-shot network observation as a successful refresh.

| Source | Fixed fact |
| --- | --- |
| WebGPU | CRD 14 July 2026; publication SHA-256 `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30` |
| GPUWeb repository | `b33e6efb182d11156851271586563cc77575059c` |
| WebGPU source files | `spec/index.bs` `39beba36023c6b9081c2a45f4e01db3fcb555517d350d5d30910dc91f0b3e408`; `copies.bs` `ff03e128d21f18ecbb30b9fea9e3fbd61718c73cc6636ace718907a4cebcf1d8`; privacy/security `9e1bcc0389d21fea6015ed72377fe94f012f4aa07cff32c0d1bc0bde03cc4b2c` |
| WGSL | CRD 16 July 2026; publication SHA-256 `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa` |
| WGSL source | `wgsl/index.bs` `73b68a97453b8b385535f63772bfdba067a86e617cbe3725adc0f3e2d02b0e2d` |
| gpuweb/types | repository `9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30`; declaration SHA-256 `d2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3` |
| Proposal index | SHA-256 `25d168b6796672bb1037933cddc31468fd10f7b7aa2f2196b7681d9f20213018` |

### Generated Authority

| Inventory | Result |
| --- | --- |
| WebGPU normative IDL | 582 entries; 0 unresolved |
| GPUWeb IDL against `@webgpu/types` | 543 comparable identities matched; 0 spec-only; 0 types-only; 6 declared representation differences |
| WGSL normative semantics | 662 entries; 6 enable extensions; 12 language extensions; 167 named built-in functions; 20 built-in values; 124 grammar productions; 0 unresolved |
| Living current coverage | 1,244 entries; 1,242 managed; 2 explained DOM-composition not applicable; 0 unresolved |
| Current classifications | 683 managed first class; 559 managed semantic equivalent; 2 not applicable |

The WGSL extractor now identifies functions by membership in the normative
Built-in Functions section instead of guessing from anchor suffixes. This
recovers `textureSample`, the texture query/load/store functions, and atomic
functions as named entries while removing the false
`built-in-function.builtin` entry. Built-in-value capability requirements are
read from the normative input/output table row by row, so `subgroups` no
longer leaks onto unrelated values such as `position` or `frag_depth`.

Format capability extraction is bounded to individual HTML tables and
individual feature sections. The resulting 92 format conditions retain
separate feature-gated facts for compression, format tiers, storage,
filterability, blendability, and `depth32float-stencil8` instead of treating
all formats as one unconditional feature conjunction.

### Dependency And Proposal Boundaries

The dependency inventory has 155 entries:

| Kind | Count |
| --- | ---: |
| enable extension to device feature | 6 |
| caller-declared companion | 1 |
| native feature implication | 3 |
| language feature to device feature | 2 |
| language feature to enable extension | 2 |
| adapter support prerequisite | 2 |
| feature alternatives | 1 |
| format-specific condition | 92 |
| limit-bound capability | 46 |

Only the six enable-to-feature facts and the one caller companion are
preflight facts. The sole caller companion remains
`subgroup-size-control -> subgroups`; the three native implications are not
converted into caller work. `feature-contract.ts` is audited against that
exact companion set.

The independent proposal watchlist contains 23 non-normative entries: 8
merged, 11 draft, 2 inactive, and 2 obsolete. The draft `subgroup-id`
proposal overlaps the formal specification; the formal WGSL entry remains
authoritative and the proposal contributes no coverage.

### Scope And Disposition

No Scratch public API, runtime behavior, examples, browser proofs, or
proposal implementation changed in this follow-up. Normal audits remain
offline, and refresh requires an explicit local `--gpuweb-root`.

The generated normative and living coverage facts are clean: every current
entry has a source anchor, explicit classification, requirements, expression
path, and bounded evidence, with zero unresolved items. The Goal's terminal
result is nevertheless `issues-found` because the one allowed online refresh
was partial. The issue is source-observation completeness, not a discovered
WebGPU/WGSL expression gap in Scratch.

## Normative Entry Evidence Attribution Follow-Up (2026-07-25)

This follow-up starts from exact `dev-feature`
`4f14d73826fd00760b0758acb04195cb257b75aa` on
`socu/scratch-normative-evidence-attribution-v1`. It hardens the proof system
only. Scratch runtime behavior, public API behavior, examples, browser
rendering, and the frozen normative inventories are outside its change scope.

### Fixed Freshness Observation

Each official source was observed once. All observations matched the fixed
baseline, so no specification drift widened this Goal:

| Source | Observed fact |
| --- | --- |
| WebGPU CRD 14 July 2026 | SHA-256 `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30` |
| WGSL CRD 16 July 2026 | SHA-256 `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa` |
| GPUWeb repository | `b33e6efb182d11156851271586563cc77575059c` |
| `gpuweb/types` repository | `9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30` |

### Historical Entry-Proof Schema (Superseded)

This section records the former schema-v3 state. It is retained as historical
review evidence and no longer describes the living coverage authority. The
current schema-v4 authority is defined by the Structured Normative Proof
Closure section below.

The former manifest gave every WebGPU and WGSL entry its own ID selector.
Reusable proof profiles were selected through explicit finite maps, but a
profile did not widen an entry's selector to an entire kind or semantic
family. A managed entry contained:

- a named proof profile and entry-specific rationale;
- public Scratch symbols resolved through the package source export graph;
- native operation evidence as exact operation/source-path pairs;
- source paths and operation lists derived from those pairs;
- typed feature, language-feature, enable-extension, limit, dependency, and
  conditional requirement arrays.

All 78 normative WebGPU methods are registered as exact rules. Their emitted
operation evidence contains one corresponding native method, except the two
documented synchronous-pipeline semantic equivalents, which deliberately
point to `createComputePipelineAsync` and `createRenderPipelineAsync`, and the
five native error constructors, which point to structured
`serializeNativeGpuError` normalization. `GPUDevice` has no owner-level rule,
so an unregistered member cannot inherit generic runtime evidence.

Non-method owner rules are limited to homogeneous finite groups. Bind-set
descriptors are separated from bind-layout descriptors; render and compute
pipeline state are separated; query allocation is separated from render and
compute timestamp writes; shader creation is separated from compilation
messages; texture allocation is separated from texture views; command
encoder creation is separated from command-buffer finish; render-bundle
encoder creation is separated from bundle finish; and texel-copy buffer and
texture records carry only the encoder and queue operations that actually
consume them. Dynamic buffer offsets are attributed to binding commands,
buffer map state and map modes to mapping, and pipeline-layout records to
native pipeline-layout creation. Regression assertions pin representative
entries from every split.

WGSL address spaces, access modes, and type sections no longer inherit one
layout proof. Host-shareable types and memory views retain `LayoutCodec`
proof; buffer types and resource-facing address/access modes use binding
proof; the immediate address space uses immediate-data proof; and ordinary
language-level types and function/private/workgroup spaces use lossless
caller-authored WGSL proof. Unknown members of each finite map fail closed.

Historical classifications remain visible in `goalStart`, but they do not
control the current verdict. In particular, descriptor fields and constants
are not retained as semantic equivalents merely because an older manifest
used that label. The current result is derived from the current finite rules:

| Result | Count |
| --- | ---: |
| WebGPU normative entries | 582 |
| WGSL normative entries | 662 |
| Managed first class | 637 |
| Managed semantic equivalent | 605 |
| Explained DOM-composition not applicable | 2 |
| Unresolved | 0 |

The 31-entry shift from first class to semantic equivalent removes claims
that `LayoutCodec` covers unrelated WGSL language semantics. It does not
remove any Scratch or native WebGPU capability.

The explicit non-composition WebGPU semantic-equivalent cases remain the
synchronous pipeline methods, raw queue exposure, mutable label, native error
scope and uncaptured-error surfaces, five native error constructors,
`GPUCommandBuffer` plus its descriptor, and the aggregate
`GPUSupportedLimits` interface. The concrete limit properties retain their
own first-class limit requirements.

### Regression And Requirement Closure

The six fixed attribution regressions now resolve as follows:

| Normative entry | Exact managed proof |
| --- | --- |
| `GPUDevice.createRenderBundleEncoder` | `RenderBundle`, `RenderBundleDescriptor`, and `ScratchRuntime` in `render-bundle.ts`; native `createRenderBundleEncoder` |
| `GPURenderPassEncoder.executeBundles` | `ExecuteRenderBundlesCommand` and `RenderBundle` in `render-bundle.ts`; native `executeBundles` |
| `interface.GPUCommandBufferDescriptor` | `SubmissionBuilder` and `SubmittedWork` in `submission.ts`; native `GPUCommandEncoder.finish` |
| `interface.GPUVertexBufferLayout` | render pipeline descriptor symbols in `pipeline-creation.ts`; native `createRenderPipelineAsync` |
| `interface.GPUTexelCopyTextureInfo` | `CopyCommand`, `TextureUploadCommand`, and `ExternalImageUploadCommand` texture endpoints in `command.ts`; `copyBufferToTexture`, `copyExternalImageToTexture`, `copyTextureToBuffer`, `copyTextureToTexture`, and `writeTexture` |
| `interface.GPUSupportedLimits` | immutable adapter/device limit facts in `runtime.ts`; interface-level `limits: []` |

Requirement validation rejects null, undefined, empty, duplicate, unsorted,
or unknown names, as well as unknown top-level and condition keys. Validation
runs against raw WGSL requirements before normalization and against the
normalized schema. The same value checks apply inside conditional
requirements. Dependency references are canonical IDs from the fixed
dependency inventory; the WGSL enable-extension manifest therefore records
`caller-companion.subgroup-size-control.subgroups` instead of duplicating a
loosely shaped feature pair.

Two consecutive generations from the same source produced byte-identical
coverage and enable-extension manifests. No runtime or example file changed.

### Adversarial Review And Bounded Correction

The single fresh-context reviewer returned `issues-found`. One bounded fact
check confirmed all six findings:

1. WGSL address-space and type-section proof families overclaimed
   `LayoutCodec` coverage.
2. Dynamic offsets, buffer mapping types, and pipeline-layout descriptors
   remained in heterogeneous WebGPU owner groups.
3. `GPUTexelCopyTextureInfo` omitted `writeTexture` and
   `copyExternalImageToTexture`.
4. The classifier accepted a known WebGPU ID with forged kind, owner, or
   member fields.
5. Requirements schema version 3 accepted unknown object keys.
6. The focused Mocha test retained a pre-v3 dependency object and stale
   timestamp evidence.

The one permitted correction addressed all six findings. Regression tests now
mutate canonical WebGPU identities, inject unknown requirement and condition
keys, exercise finite WGSL profile boundaries, and pin the additional owner
splits and texture queue operations. The focused current-coverage audit and
Mocha test pass after regeneration.

The committed document does not preclaim the final full gate. That gate runs
once against the final clean commit, and its result is reported in the
terminal Goal report.

## Structured Normative Proof Closure (2026-07-25)

This section supersedes every earlier description of the living coverage
proof system, including schema-v3 operation/source pairs and any historical
token or regular-expression proof path. Those paths are not compatibility
inputs and are not consulted by the current generator or audits.

### Schema-V4 Authority

The living manifest is
`manifests/scratch-webgpu-wgsl-current-coverage.json`. Its external strict
schema is
`manifests/scratch-webgpu-wgsl-current-coverage.schema.json`, and its runtime
validator and executable proof engine are implemented in
`scripts/scratch-webgpu-wgsl-structured-proof.mjs`.

Every one of the 1,244 formal inventory IDs occurs exactly once. Each entry
binds its formal ID, domain, kind, source anchor, coverage rule, public
Scratch expression, requirements, and structured proof. Managed native
lowering is represented only by discriminated `operationEvidence`; the old
evidence-record operation strings were removed rather than retained as a
fallback.

The current closure remains:

| Result | Count |
| --- | ---: |
| WebGPU normative entries | 582 |
| WGSL normative entries | 662 |
| Managed first class | 637 |
| Managed semantic equivalent | 605 |
| Explained DOM-composition not applicable | 2 |
| Unresolved | 0 |

The only not-applicable IDs remain
`includes.Navigator.NavigatorGPU` and
`includes.WorkerNavigator.NavigatorGPU`. The N/A validator accepts no other
composition.

### Executable Proof Model

The proof engine builds a TypeScript `Program` and `TypeChecker` from the
package build tsconfig plus the declared proof sources. It resolves the real
package export graph, declarations, calls, constructor calls, property
reads/writes, contextual descriptor fields, receiver types, WGSL payload
flow, layout contracts, browser fixture contracts, and N/A composition.

Comments, ordinary strings, wrong receiver types, wrong source files,
non-exported symbols, another entry's valid type member, mismatched WGSL
contract IDs, wrong normative anchors, duplicate selectors, unknown proof
kinds, and incomplete summary facts all fail closed. Native lowering for a
managed entry must originate under `packages/geoscratch/src/scratch/`; a
direct raw-device call in a test, example, or other package module cannot be
counted as managed Scratch evidence.

WGSL entries bind their exact formal ID to the caller-authored source snapshot
that becomes `GPUShaderModuleDescriptor.code` and to the typed
`GPUDevice.createShaderModule` call. Layout profiles additionally bind the
`LayoutCodec` packing, accessor, and readback-view contract. Enable and
language extensions bind their exact feature contracts, and every other
managed WGSL entry binds an explicit executable proof profile. Browser
selectors preserve the full entry requirements and prove by symbol identity
that the runner result, rather than an unrelated value, reaches the matching
result collection. A WGSL-looking string that is not carried into the native
shader descriptor is not proof.

### Requirements And Corrected Facts

Requirements remain typed, sorted, unique, and restricted to fixed
normative feature, language-feature, extension, limit, dependency, and
condition inventories. Browser proof features must equal the entry's device
requirements.

The structural migration corrected two proof facts without changing a
classification:

| Entry or operation | Correction |
| --- | --- |
| texture readback `copyTextureToBuffer` | Native call evidence now points to `scratch/command.ts`, where the call exists, rather than the normalization-only `texture-readback.ts` module |
| `language-extension.texture_formats_tier1` | Browser execution proof now retains the required `texture-formats-tier1` device feature |

Two consecutive generations produced byte-identical current-coverage,
enable-extension, and external-schema artifacts.

### Fixed Source Observation

The Goal performed one bounded observation only. The WGSL publication,
GPUWeb editor commit
`b33e6efb182d11156851271586563cc77575059c`, `gpuweb/types` commit
`9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30`, and proposal metadata were
observed. The WebGPU publication request returned a fetch error and was not
retried. The checked local WebGPU CRD hash remains
`23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30`;
the checked WGSL CRD hash remains
`2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa`.
No formal inventory delta was introduced.

### Scope

This closure changes proof tooling, generated review artifacts, audits, and
tests only. It does not change Scratch runtime behavior, public API behavior,
examples, formal specification snapshots, or proposal implementation. It
does not preclaim the final full gate.

### Independent Structured-Proof Review

The one permitted independent read-only review returned `issues-found` for
three proof-chain weaknesses: generic WGSL entries lacked profile-bound
execution, browser result collection was not tied to the runner return value,
and adapter-info members shared only aggregate snapshot evidence.

The single concentrated correction closed those findings. All 662 managed
WGSL entries now have exactly one browser execution proof, distributed over
6 enable contracts, 12 language contracts, and 9 normative profile
contracts. The matcher follows TypeChecker symbols from runner assignment to
the pushed result. `GPUAdapterInfo` now has exact native lowering for
`architecture`, `description`, `device`, `isFallbackAdapter`,
`subgroupMaxSize`, `subgroupMinSize`, and `vendor`, with `adapter.info`
retained as the snapshot source.

The focused headed browser matrix passed with 28 unique proofs: 25 executed
and passed, 3 capability-specific skips, no failures or captured/uncaptured
GPU errors, and clean terminal state for every executed runtime. No second
review was performed.
