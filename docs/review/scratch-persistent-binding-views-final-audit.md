# Scratch Persistent Binding Views Final Audit

Date: 2026-07-14
Status: Post-sixteenth-review fixes; clean acceptance and independent re-review pending
Decisions: ADR-036, ADR-037, ADR-038

## Fixed Evidence

- Goal-start TypeScript baseline: `26c6d8875caea7612e573dfb4e33e1340a016d46`
- Historical pre-TypeScript JavaScript reference: `20bb393df570ff1914a6789e9bd422d59ddfecc8`
- Audit target: `socu/scratch-persistent-binding-views-v1`
- Structural audit: `node tests/audits/scratch-persistent-binding-views-final-parity.mjs`
- Final acceptance: `SCRATCH_FINAL_AUDIT=1 node tests/audits/scratch-persistent-binding-views-final-parity.mjs`
- Native authority: [WebGPU resource binding](https://gpuweb.github.io/gpuweb/#resource-binding), [texture views](https://gpuweb.github.io/gpuweb/#texture-view-creation), [copies](https://gpuweb.github.io/gpuweb/#copies), [query sets](https://gpuweb.github.io/gpuweb/#query-sets), and [Web IDL integer conversion](https://webidl.spec.whatwg.org/#es-integer-types)

The executable audit uses the TypeScript compiler AST to derive exports and every
public exported-class constructor, property, method, getter, setter, parameter type,
and return type from the fixed source trees. It performs a complete production emit
in memory and compares every generated JavaScript and declaration file byte-for-byte
with `dist`; native copy calls and binding lowering are also AST-resolved.

Structural mode deliberately reports `verification.status: incomplete`. Acceptance
mode first requires a clean Git working tree and reports the exact HEAD commit, empty
porcelain inventory, and porcelain hash. It then downloads the GPUWeb Bikeshed main
source, copy-rules source, and WHATWG Web IDL source; derives the native enum matrices;
first verifies that its managed browser port is unoccupied, then explicitly executes
`npm run typecheck`, `npm run build`, and `git diff --check`. It executes exactly 394
referenced behavior tests; requires the complete suite to report exactly 817 passing
and 2 intentionally pending gates; runs both 20,000-cycle steady-state phases; starts
and stops its own Vite development server; and launches both the non-headless binding
proof and the 11-page ordinary-example matrix. During that same managed-server
lifecycle it launches a fixed unavailable-target probe and requires a non-zero
`ERR_CONNECTION_REFUSED` result. It accepts no external-server mode or environment
override. After browser, negative-target, focused/full Mocha, and stress work has
finished, it rechecks the exact HEAD plus clean working tree once for the complete
execution sequence.

The Goal-start commit is the behavioral and public-symbol baseline. The historical
JavaScript commit is evidence for behavior that had already survived the TypeScript
migration; it is not authority for restoring synchronous factories, old names, or
legacy descriptor shapes. ADR-036 through ADR-038 define the clean target state.

## Final Parity Table

| Area | Goal-start TypeScript behavior and public symbols | Historical JavaScript feature inventory | Target clean-cut behavior | Final implementation location | Test evidence | Documentation evidence | Intentional breaking replacement | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime and surface | Async runtime plus independent `Surface` and `SubmissionBuilder` | Same runtime/surface separation | Preserve explicit async runtime and non-resource descriptions | `scratch/runtime.ts`, `surface.ts`, `submission.ts` | Runtime, surface, submission suites | Vision 01 and overview | Preserved and strengthened | Complete |
| Resource semantics | Universal allocation/content facts | Allocation and scalar content epochs existed | Allocation lifecycle on every resource; scalar content only on buffers/textures; indexed query facts | `resource.ts`, `buffer.ts`, `texture.ts`, `sampler.ts`, `query-set.ts` | Resource-semantics and supporting-object suites | Vision 02, ADR-036 | Universal `ResourceState` narrowed to truthful owners | Complete |
| Layout codecs | `structuralHash`, CPU packing, WGSL accessors, readback views | LayoutCodec did not yet exist | Collision-safe canonical `abiHash` plus `schemaHash`, preserving codec helpers | `layout-codec.ts` | Layout-codec and resource-view suites | Vision 02, ADR-036 | `structuralHash` removed without alias | Complete |
| Buffer ranges | Resource-global layout/stride/count | Raw `BufferResource` existed | Raw buffer plus frozen `BufferRegion`; every public range consumer uses regions | `buffer.ts`, `command.ts`, `readback.ts`, `binding.ts` | Resource-view, region-layout, copy, readback suites | Vision 02 and 07, ADR-036 | Resource-global layout and ad hoc ranges removed | Complete |
| Texture views | Public allocation-scoped `GPUTextureView` cache | Public `createView()` existed | Frozen logical `TextureViewSpec`; native usage/format capability preflight; candidate/submission-local native views stay private | `texture.ts`, `texture-format-capabilities.ts`, `binding.ts`, `pass.ts`, `submission.ts` | Resource-view, BindSet preparation, pass tests | Vision 02, 03, 05; ADR-036/037 | Public managed native view and global cache removed | Complete |
| Supporting objects | Sampler, QuerySet, and BindLayout factories returned synchronously | Synchronous native constructors existed | Promise-only candidate transactions with scoped native acknowledgement | `runtime.ts`, `sampler.ts`, `query-set.ts`, `binding.ts` | Supporting-object acknowledgement suite | Vision 03, ADR-037 | Sync factories and constructor bypasses removed | Complete |
| Persistent BindSet | Lazy `getBindGroup()` rebuilding and allocation checks | Same lazy binding path | Initially acknowledged prepared set; explicit single-flight `prepare()` only after allocation staleness; submission never repairs | `binding.ts`, `command.ts` | BindSet preparation, lifecycle, performance suites | Vision 03/04, ADR-037 | Lazy submission-time creation removed | Complete |
| Program and command binding | `ProgramBufferLayoutRequirement`, one structural hash, descriptor-level offsets | Program modules/entry points/features existed; typed requirements did not | ABI/schema-aware command validation and immutable command-owned named offsets pre-lowered to native order | `program.ts`, `command.ts`, `binding.ts` | Dynamic-offset and binding-access suites | Vision 03/04, ADR-036/037 | `CommandDynamicOffsets` replaced by `CommandBindSetInvocation` | Complete |
| Commands, passes, submission | Stable command/pass objects, queue order, readiness, epochs | Draw/dispatch/copy/submission path existed | Region/view specs flow through stable commands; pass attachments remain submission-observed; no hidden binding preparation | `command.ts`, `pass.ts`, `submission.ts` | Queue-order, epoch, native-provenance suites | Vision 04/05/07 | Whole-resource range/attachment shapes removed | Complete |
| Readback, query, copy | Layout-aware readback and all four native copy directions | Raw/typed readback and buffer-to-buffer copy existed | `BufferRegion` readback/query resolve and all four direct GPU copy quadrants | `readback.ts`, `command.ts`, `submission.ts` | Copy, readback, query, browser suites | Vision 04/07 | `ReadbackRange` and whole-buffer overloads removed | Complete |
| Diagnostics | GPU operation schema v4 and broad resource-shaped facts | Structured `SCRATCH_*` diagnostics existed | Bounded schema v5 with discriminated resources, supporting objects, views, and indexed query slots | `gpu-operation.ts`, `runtime-diagnostics.ts` | Schema-v5, bounded evidence, browser failure probes | Vision 09, ADR-038 | Schema v4 writers and fabricated content/footprint facts removed | Complete |

## Historical JavaScript Type Disposition

The historical hand-written package declaration exposed 18 Scratch-specific names
whose disposition required an explicit decision. Fifteen remain public target types;
three implementation-normalization helpers remain internal.

| Historical name | Final disposition | Reason | Status |
| --- | --- | --- | --- |
| `BufferResourceDescriptor` | Public, restored | Native raw buffer descriptor remains part of creation | Complete |
| `NormalizedDrawVertexBufferBinding` | Internal | Normalization result is not a public input contract | Complete |
| `ProgramDescriptor` | Public, restored | Program source contract | Complete |
| `ProgramEntryPoints` | Public, restored | Named shader entry-point contract | Complete |
| `QuerySetResourceDescriptor` | Public, restored | Promise-only query creation input | Complete |
| `QuerySetType` | Public, restored | Core timestamp/occlusion discriminator | Complete |
| `ResourceOptions` | Internal | Base-resource construction is closed | Complete |
| `SamplerResourceDescriptor` | Public, restored | Promise-only sampler creation input | Complete |
| `ScratchComputePipelineDescriptor` | Public root alias, restored | Avoids collision with the older package pipeline | Complete |
| `ScratchDiagnosticInput` | Public, restored | Structured diagnostic construction input | Complete |
| `ScratchRenderPipelineDescriptor` | Public root alias, restored | Avoids collision with the older package pipeline | Complete |
| `SurfaceFormat` | Public, restored | Surface format policy | Complete |
| `SurfaceOptions` | Public, restored | Surface creation options | Complete |
| `SurfaceSize` | Public, restored | Surface sizing contract | Complete |
| `TextureUploadLayout` | Public, restored | Queue upload byte layout | Complete |
| `TextureUploadOrigin` | Public, restored | Queue upload origin | Complete |
| `TextureUploadSize` | Public, restored | Queue upload extent | Complete |
| `TypedArrayConstructor` | Internal | Materialization helper is inferred from the call | Complete |

The executable audit reports 36 Goal-start value exports, 29 historical JavaScript
value exports, and 38 final value exports. None is silently missing. The production
compiler emits 102 JavaScript files and 102 declaration files; every one matches
`dist` exactly, with no missing, stale, or mismatched transitive output. The declaration
AST manifest covers 4,718 declaration/member nodes. Scratch source contains only `.ts`
and no hand-written `.d.ts` or same-source `.js`.

## AST-Derived Public Member Disposition

The compiler-emitted declaration inventory contains 357 Goal-start public class
members and 378 final public class members; the historical source/declaration inventory
contains 173 method/getter/setter entries. Every member record includes its kind,
modifiers, parameter names and types, optional/rest shape, and inferred or declared
return/property type. The audit fails if a missing or changed Goal-start contract is
absent from an explicit disposition map. It classifies all 21 missing Goal-start
members, all 10 changed Goal-start signatures, and all 16 missing historical
method/getter/setter entries.

| Missing Goal-start entry | Target disposition |
| --- | --- |
| `BindLayout` / `BindSet` constructors | Promise-only acknowledged runtime factories; BindSet is initially prepared |
| `BindSet.getBindGroup()` | Explicit `prepare()` plus private committed bind-group lookup |
| `BindSet.hasStaleAllocationVersions()` | Allocation-bound `preparationState` |
| `BufferResource.layout/layoutByteLength/elementCount` | `BufferRegion` owns every typed interpretation fact |
| `BufferResource.layoutSubject` | `BufferRegion.subject` and region-owned layout |
| `QuerySetResource._advanceSlotContentEpoch()` | Module-private indexed-slot epoch helper |
| `QuerySetResource` constructor / `create()` | Promise-only `ScratchRuntime.createQuerySet()` |
| `ReadbackCommand.range` | `source.region: BufferRegion` |
| `ReadbackOperation.range` | `source: BufferRegion` |
| `RenderPassSpec.createRenderPassDescriptor()` | Submission-scoped internal `lowerRenderPassDescriptor()` so native attachments stay observed |
| `Resource` constructor | Protected subclass allocation lifecycle |
| `Resource.state/contentEpoch/isReady` | Buffer/Texture content owners and indexed QuerySet slots only |
| `SamplerResource` constructor / `create()` | Promise-only `ScratchRuntime.createSampler()` |
| `TextureResource.createView()` | Logical `TextureResource.view(): TextureViewSpec` |

The 10 changed signatures are also explicit: `BindLayout.entrySubject()` accepts
`unknown` so malformed input still receives structured diagnostics;
`ReadbackOperation.source` is a `BufferRegion`; and the sampler, query-set, bind-layout,
and bind-set runtime factory/alias methods return ordinary `Promise` values.

Historical-only missing entries are also explicit: Buffer/Texture static factories
move to Promise-only runtime factories; QuerySet lifecycle methods are inherited;
underscore readback/resource/texture mutators become module-private helpers. These
are clean cuts, not accidental omissions or names restored from old JavaScript.

## Official Persistent Binding Matrix

The structural matrix is derived from installed `@webgpu/types` 0.1.71 rather than
duplicating expected literals in the audit. Final acceptance downloads the GPUWeb
Bikeshed source, parses the six corresponding native enums, and requires exact parity
with the installed provider and Scratch. Scratch's public `read-storage` name lowers
to WebGPU `read-only-storage`; every other row uses native vocabulary directly.

| Family | Required values | Scratch result |
| --- | --- | --- |
| Buffer binding type | `uniform`, `read-only-storage`, `storage` | Complete |
| Sampler type | `filtering`, `non-filtering`, `comparison` | Complete |
| Sampled texture sample type | `float`, `unfilterable-float`, `depth`, `sint`, `uint` | Complete |
| Sampled texture view dimension | `1d`, `2d`, `2d-array`, `cube`, `cube-array`, `3d` | Complete |
| Storage texture access | `write-only`, `read-only`, `read-write` | Complete |
| Storage texture view dimension | `1d`, `2d`, `2d-array`, `3d` | Complete |

`externalTexture` is deliberately excluded because its video/frame/task lifetime is
not a persistent binding contract. It requires a separate Goal rather than a false
persistent-resource abstraction.

The audit AST-extracts each source set, verifies `lowerBindLayoutEntry()` assigns all
four native descriptor members, and acceptance executes the referenced behavioral
cases for every family, sample type, sampler type, sampled/storage dimension,
multisampling, incompatibility, stage/feature/slot limit, and sampler field
normalization. A file or test title alone is never acceptance evidence.

Pipeline layout lowering preserves native group identity: each `BindLayout.group`
selects the corresponding `bindGroupLayouts[N]` slot and sparse groups retain explicit
`null` holes. Dynamic-buffer and per-stage slot limits are also rechecked over the
concatenated entries from every group, matching the complete `GPUPipelineLayout`
contract rather than treating each group as an independent budget.

## Native Copy Matrix

| Direction | Native WebGPU call | Historical JavaScript | Goal-start TS | Final path | CPU round trip |
| --- | --- | --- | --- | --- | --- |
| Buffer to buffer | `copyBufferToBuffer()` | Present | Present | Direct encoder call | None |
| Texture to texture | `copyTextureToTexture()` | Not yet present | Present | Direct encoder call | None |
| Buffer to texture | `copyBufferToTexture()` | Not yet present | Present | Direct encoder call | None |
| Texture to buffer | `copyTextureToBuffer()` | Not yet present | Present | Direct encoder call | None |

CPU uploads and mapped readback remain separate explicit operations. They do not
substitute for any GPU-side copy direction.

Buffer-to-buffer copies additionally require distinct parent GPU buffers. Scratch
rejects same-buffer source and target regions regardless of whether their byte ranges
overlap, matching the native rule rather than inventing a memmove-like exception.

Each row requires exactly one AST-resolved call on `commandEncoder` inside
`CopyCommand`, zero mapping/read-buffer calls in that class, and one executed fake-GPU
behavior test that records the corresponding encoder call.

Texture-copy validation also follows the native subresource rules: 3D mip levels
shrink depth while 2D array-layer counts remain fixed; same-texture copies are allowed
only when their mip/layer subresource sets are disjoint; and equal formats or matching
linear/`-srgb` pairs are copy-compatible. Multisampled and depth/stencil copies require
complete physical source and target subresources. Compatibility devices reject
compressed texture-to-texture copies and remain limited to sample count 1. On core
devices, compressed mip extents are rounded to their physical texel-block dimensions,
and source/target origins plus copy extents must be block-aligned. Focused RED/GREEN
tests and markers from the official GPUWeb copy-rules source lock every case.

Buffer-texture validation resolves every one of the 95 official non-depth/stencil
formats to its texel-block dimensions and 1, 2, 4, 8, or 16-byte copy footprint. It
computes linear layout ranges in block rows, applies the native depth/stencil
single-aspect direction matrix and 4-byte buffer-offset alignment, and requires full
physical depth/stencil subresources. Compatibility mode allows compressed
buffer-to-texture copies but rejects compressed texture-to-buffer copies; core mode
admits both. Every path is a direct encoder copy with no CPU round trip.

## Diagnostics Evidence

- Goal-start diagnostic code inventory: 158
- Final diagnostic code inventory: 196
- Unexpected missing codes: 0
- `SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH` is intentionally replaced by
  `SCRATCH_LAYOUT_ABI_MISMATCH` and `SCRATCH_CODEC_SCHEMA_MISMATCH`.
- `SCRATCH_READBACK_RANGE_INVALID` is intentionally replaced by
  `SCRATCH_BUFFER_REGION_RANGE_INVALID` and
  `SCRATCH_BUFFER_REGION_LAYOUT_INVALID`.
- GPU operations, incidents, captures, snapshots, and exported evidence emit schema
  version 5; no schema-v4 writer remains.
- BindSet preparation evidence is bounded. Steady-state command use does not append a
  full binding snapshot or create a preparation operation.

## Browser Evidence

Headed Chrome 150.0.7871.115 used the public built package on Apple Metal 3.
The adapter exposed `timestamp-query`, `texture-component-swizzle`, storage format
tiers, and the other feature list retained in the JSON runner output.

- One buffer produced typed regions at offsets `0` and `256`, plus an overlapping raw
  region; ABI/schema hashes were stable.
- Two frozen commands shared one BindSet and produced exact dynamic-offset values
  `[17, 33]`.
- Texture replacement preserved resource/view identity, advanced allocation version
  `1 -> 2`, rejected stale submission with `SCRATCH_BIND_SET_STALE` before encoder
  creation, then explicit preparation advanced generation `1 -> 2`.
- The reused command produced buffer value `17` and storage pixel `[17, 0, 0, 255]`.
- Every `storage` buffer was initialized and declared at parent-resource granularity
  as both read and write. Read-only storage texture access returned `41`; read-write
  storage texture access changed `5 -> 6`.
- Occlusion slot 0 resolved to `1`; both timestamp slots became ready and their
  resolved values were monotonic. This adapter returned `0, 0`, so no non-zero timing
  magnitude is claimed.
- Controlled invalid WGSL produced aggregate
  `SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES`, including
  `SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED`, with schema-v5 incident evidence.
- Evidence survived JSON round trip; pending operations, console errors, page errors,
  request failures, and uncaptured errors ended at zero.
- The existing headed browser matrix passed all 11 ordinary examples with nonblank
  pixel/output checks. Readback and delayed-submission native-provenance probes also
  passed.

Real-browser OOM was not forced. Deterministic OOM, scope, lifecycle, and disposal
races are covered by fake-device transaction tests, matching the Goal's evidence
boundary.

The browser proof is connected to an executable Mocha acceptance gate:

```sh
SCRATCH_BINDING_BROWSER_GATE=1 npx mocha tests/scratch-persistent-binding-browser.test.js
```

The environment flag is intentionally required because default Node/CI environments
may have no headed WebGPU browser. Final acceptance always runs the enabled gate and
parses the returned device, exact-value, diagnostics, and zero-leak fields.

## Performance Evidence

The deterministic runner executed `20,000 + 20,000` unchanged binding cycles around
one allocation replacement on Node `v22.22.3`, Apple M1 Max:

| Phase | Cycles | Bind groups | Texture views | Scope pushes/pops | Preparation operations | Allocation attempts | Generation/snapshot changes | Offset identity/name reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| First steady state | 20,000 | +0 | +0 | +0/+0 | +0 | +0 | +0 / none | 0 / 0 |
| Explicit replacement preparation | one shared Promise | +1 | +1 | bounded transaction | +1 | bounded transaction | `1 -> 2` / changed once | not a steady-state claim |
| Second steady state | 20,000 | +0 | +0 | +0/+0 | +0 | +0 | +0 / none | 0 / 0 |

The enhanced gate additionally records zero preparation-snapshot serializations,
zero binding-order sorts, and a real before/after comparison of BindSet, binding map,
binding, resource, generation, hash, and state identities. Measured wall time after
the seventh review fixes was 68.47 ms then 49.81 ms (3.42 and 2.49 microseconds per
cycle). These timings are observations,
not performance thresholds. The zero-allocation claim applies only to persistent
binding preparation/preflight bookkeeping, not to complete browser submission or
native driver work.

The clean fourteenth-review acceptance measured 1.16 and 0.74 microseconds per cycle
for the two 20,000-cycle phases. These are likewise observations, not thresholds.

Steady-state staleness checking is an allocation-free indexed scan of the immutable
dependency/version array captured by preparation. No O(1) claim is made: the Goal
explicitly forbids a Resource-to-BindSet reverse graph, so exact staleness detection
must compare the finite bound dependencies. The removed hot path rebuilt, sorted,
canonicalized, serialized, and hashed a complete snapshot on every check.

## Examples And Documentation

- 11 ordinary examples import `geoscratch`, use only the target API, and do not reach
  into package source.
- 3 legacy examples remain: `m_demLayer (legacy)`, `m_flowLayer (legacy)`, and
  `x_helloGAW (legacy)`.
- DEM and Flow remain separate implementations.
- No `scratch_` example naming flag remains.
- Hello Map remains absent.
- Vision 02/03/04/05/07/08/09, ADR-036/037/038, the supersession notices on
  ADR-008/009/010, package exports, tests, examples, and generated declarations agree
  on the final contract.

## Intentional Clean Cuts

- Resource-global buffer layout -> immutable `BufferRegion` layout witness
- Public native texture view/cache -> logical `TextureViewSpec`
- `structuralHash` -> `abiHash` plus `schemaHash`
- Synchronous supporting-object factories -> Promise-only acknowledgement
- Public/direct construction -> runtime factories with closed constructors
- Lazy submission-time BindSet repair -> explicit allocation-bound `prepare()`
- Descriptor-level/raw dynamic offsets -> command-owned named offsets pre-lowered once
- Whole-buffer/range overloads -> `BufferRegion`
- Diagnostics schema v4 -> schema v5
- Public `RenderPassSpec.createRenderPassDescriptor()` -> internal submission-observed lowering

No compatibility aliases, dual descriptor shapes, background retry, reverse dependency
graph, CPU copy substitute, or hidden submission preparation was retained.

## Fresh-Context Strict Review

Fourteen isolated review passes have examined the fixed-baseline diff and working tree.
The first core review confirmed one Important performance defect. The first parity
review confirmed three P1 and three P2 evidence defects. The second parity review
confirmed two P1 and two P2 defects in copy semantics, audit execution, transitive
declaration coverage, and ResourceState documentation. The third parity review
confirmed four correctness and evidence defects in storage access, multisample copies,
canon status, and obsolete audit ownership. Reviews five through nine confirmed eight
further documentation, diagnostic, compressed-copy, format-matrix, and acceptance-gate
defects. The tenth review confirmed two P1 audit-target/inventory defects and one P2
Web IDL sampler-normalization defect. The eleventh review confirmed four pipeline-layout,
copy, aggregate-limit, and texture-view capability defects. The twelfth review confirmed
six lifecycle-causality, attachment-view, BufferRegion alignment, attachment-format,
descriptor-normalization, and depth-clear defects.
The thirteenth review confirmed two P1 defects in default depth lowering and BindSet
lifecycle evidence plus one P2 test-evidence overstatement. No Critical issue was
reported. The fourteenth review confirmed five P1 and two P2 defects in current
`depthSlice` validation, Web IDL numeric/clear normalization, depth-only rendering,
acceptance execution, copy diagnostics, and attachment-dimension documentation.

Resolved core finding:

1. `BindSet.assertUsable()`, `preparationState`, and cached `prepare()` each rebuilt a
   complete snapshot. The RED test measured 96 serializations for 32 unchanged loops.
   Prepared snapshots now retain a private dependency/version array; the steady path
   performs only allocation-free scalar checks, cached prepare returns directly, and
   bind-group lookup does not repeat validation in the same synchronous encode path.
   Focused lifecycle tests caught and fixed one disposed-dependency slow-path bypass.

Resolved parity/evidence findings:

1. Hand-maintained coverage is now supplemented by AST-derived public method/getter
   inventories and exact explicit disposition sets for every missing entry.
2. Matrix sets and native lowering are AST-derived and tied to named behavior tests;
   copy methods are AST-resolved calls tied to all four encoder behavior tests.
3. Public declarations are re-emitted in memory by TypeScript and exact-byte/hash
   compared for all three entrypoints.
4. Stress no longer hardcodes `bindSetMutated: false`; it compares actual identities
   and facts and measures snapshot serialization/sort/name-map counters.
5. `RenderPassSpec.createRenderPassDescriptor()` is explicitly classified as internal
   submission-scoped lowering.
6. The browser test now has an enabled headed acceptance mode that executes and parses
   the real runner.

Resolved second parity findings:

1. Texture copy validation now shrinks 3D mip depth, preserves 2D array-layer depth,
   permits only disjoint same-texture mip/layer subresources, and accepts native
   linear/`-srgb` format pairs.
2. Structural mode can report only `incomplete`. Acceptance fetches and parses the
   official GPUWeb source, executes the named Mocha cases, 20k + 20k stress, and headed
   browser proof. The disabled Mocha gates use `this.skip()` and no-server acceptance
   fails non-zero.
3. Production emit parity covers all 102 JavaScript plus 102 declaration files, rejects
   stale transitive files, and fingerprints 4,718 declaration/member signatures.
   Goal-start public properties and complete member signatures are explicitly audited.
4. English and Chinese canon now match the three-state `ResourceState` and
   `QuerySetSlotState`; disposal remains the separate `resource.isDisposed` lifecycle.

Resolved latest review findings:

1. WebGPU `storage` buffer bindings are now treated as read-write, so command access
   preflight requires the parent buffer in both declarations. Empty read-write storage
   fails readiness before encoder creation; examples, type probes, unit tests, and the
   headed browser runner initialize such outputs and declare exact read epochs.
2. Texture-to-texture copies require equal sample counts. Compatibility devices remain
   limited to sample count 1; core devices accept equal multisample copies only for a
   complete physical subresource, with focused acceptance coverage and official-spec
   markers for both rules.
3. Vision 08/09 now teach `BufferRegion`-owned layouts and the current diagnostic-code
   set. ADR-008 is superseded by ADR-036; ADR-009/010 retain only their surviving
   contracts and explicitly defer resource-global layout assumptions to ADR-036.
4. The obsolete submission-native final audit and runner were removed. Active review
   documents now point to this fixed-baseline executable audit as the final authority.

Resolved fifth review findings:

1. ADR-008/009/010 no longer leave removed contracts under a normative `Decision`
   heading. Each now separates its superseded historical record from an explicit
   `Current Replacement` section governed by ADR-036; Vision 08 describes
   `BufferRegion` witnesses rather than resource-global layouts.
2. The audit now extracts every `SCRATCH_*` literal from every bilingual Scratch Vision
   module, requires exact English/Chinese set parity per module, and rejects every code
   absent from current TypeScript source. All 122 codes documented at that review stage
   were source-backed; stale query and generic resource codes were replaced by the
   operation-specific codes actually emitted by Scratch.

Resolved sixth review findings:

1. Texture-to-texture preflight now applies the native complete-physical-subresource
   rule to depth/stencil formats as well as multisampled textures. Compatibility devices
   reject compressed texture copies and still require sample count 1. Focused tests cover
   both rejection paths and their core-device positive cases; acceptance verifies the
   exact rules from GPUWeb `spec/sections/copies.bs`.
2. Vision diagnostic parity is now bidirectional. The audit rejects both documented
   codes absent from TypeScript and implemented codes absent from the bilingual Vision
   set. Vision 09 now inventories the previously missing BindSet preparation, copy,
   pass, pipeline, readback, supporting-object, runtime, surface, and lifecycle codes;
   English, Chinese, and implementation each contain the same 196-code set.

Resolved seventh review finding:

1. Core-device compressed texture copies now use physical mip extents rounded up to
   the format's texel-block width and height. Source and target origins and copy extents
   must be block-aligned. A focused BC1 test proves that a 12 x 12 texture's mip 1
   accepts the native-valid 8 x 8 physical copy while rejecting 6 x 6 and a source
   origin of x = 2. The implementation reuses the texture descriptor's existing block
   metadata rather than maintaining a second compressed-format table.

Resolved eighth review finding:

1. Final acceptance no longer treats a zero-failure subset as sufficient evidence for
   the published test totals. The executable gate now requires exactly 348 focused tests
   with no failures or pending cases, then independently discovers every `tests/**/*.test.js`
   file and requires exactly 804 tests: 802 passing, zero failures, and only the two
   intentionally disabled headed-browser/final-acceptance gates pending. Any missing test,
   extra pending case, or discovery drift fails final acceptance.

Resolved ninth review findings:

1. Full-suite acceptance now compares the exact relative file and full Mocha title of
   both intentionally pending gates. Two unrelated skipped tests can no longer satisfy
   the aggregate count.
2. Buffer-texture copies now cover the official 95-format color inventory, all native
   texel-block footprints, block-row range calculation, depth/stencil single-aspect
   footprints and direction limits, full physical depth/stencil subresources, and the
   asymmetric compatibility restriction on compressed texture-to-buffer copies. The
   installed `@webgpu/types` format union is checked against the live GPUWeb enum before
   the exhaustive behavior test is accepted.

Resolved tenth review findings:

1. The native-call scanner previously recognized only `.gpuTexture.createView()` and
   omitted the surface path. It now inventories the current surface texture's
   `GPUTexture.createView()` in `pass.ts` and the underlying
   `GPUCanvasContext.getCurrentTexture()` in `surface.ts`, bringing the exact total to
   41. Submission lowering owns both calls at `pass-begin`; direct public
   `Surface.getCurrentTexture()` remains explicitly deferred.
2. Acceptance previously reported only HEAD while auditing uncommitted files. The
   runner now records commit plus porcelain evidence and rejects acceptance before any
   expensive step unless the entire Git working tree is clean. Structural mode remains
   usable during implementation but cannot claim acceptance.
3. `maxAnisotropy` now applies Web IDL `[Clamp] unsigned short` normalization before
   WebGPU validation and descriptor hashing: it clamps to `[0, 65535]`, rounds to the
   nearest integer with ties to even, then enforces the normalized minimum and linear
   filter rule. Numeric boundary, non-finite, and tie cases are executable tests, and
   acceptance checks the live GPUWeb and WHATWG source markers.

Resolved eleventh review findings:

1. Pipeline layout lowering now indexes native `bindGroupLayouts` by
   `BindLayout.group`, inserts `null` for sparse groups, and ignores caller array order.
   The compute pipeline regression proves groups `2` then `0` lower to
   `[group0, null, group2]`.
2. Buffer-to-buffer copy now rejects every source/target pair backed by the same
   `GPUBuffer`, including disjoint regions. It no longer applies a weaker overlap-only
   rule that WebGPU does not expose.
3. Pipeline creation concatenates entries across every BindLayout and rechecks all
   dynamic-buffer and per-stage binding-slot limits over the complete pipeline layout.
   Individually valid groups that collectively exceed sampler or dynamic-uniform limits
   fail before native pipeline issue.
4. Texture and texture-view preflight share one current format-capability table with
   storage-texture BindLayout validation. Transient views require exact parent usage;
   render views require a device-enabled renderable format; storage views require at
   least one device-enabled storage access mode.

Resolved twelfth review findings:

1. Supporting-object creation no longer races scope settlement against runtime disposal
   or device loss. Every already issued scope settles first; synchronous native failure,
   structural scope failure, validation, internal, and OOM evidence retain causal
   priority, while later lifecycle facts remain secondary evidence. The transaction
   performs a final lifecycle recheck before commit.
2. Persistent color and depth/stencil attachments now validate the actual
   `TextureViewSpec` usage, not only the parent texture usage. Render views must contain
   `RENDER_ATTACHMENT`; transient views default to and require `clear` plus `discard` for
   every writable aspect.
3. Every migrated `BufferRegion` consumer now preserves its underlying native alignment:
   buffer upload offset/length, direct and ordered readback source offset/size, and vertex
   buffer offsets all enforce the relevant 4-byte rule before native or staging effects.
4. The actual attachment view format is authoritative. Optional pass format metadata must
   match it, and an explicit Surface view descriptor must preserve the configured format,
   2D single-subresource shape, all aspect, RGBA swizzle, and render-attachment usage.
5. Raw Buffer/Texture descriptors reject noncanonical integer, flags, label, and boolean
   values before native issue. Retained logical descriptors can no longer differ from the
   values Web IDL would otherwise coerce for the native call.
6. `depthClear` accepts only finite values in the inclusive `[0, 1]` native range. The
   new regressions cover both bounds, non-finite inputs, and out-of-range values.

Resolved thirteenth review findings:

1. A writable depth attachment that defaults to `depthLoad: 'clear'` now also defaults
   `depthClear` to `1`. Submission lowering therefore always emits the required
   `depthClearValue`; explicit `0` and `1` remain valid.
2. BindSet preparation now appends its aggregate lifecycle recheck before selecting
   failure order even when native failures already exist. One native validation failure
   remains primary while concurrent runtime disposal is retained as a lifecycle-recheck
   secondary incident outcome.
3. Depth-clear regressions now execute the inclusive `0` and `1` boundaries, `NaN`, both
   infinities, and values below and above the native range. The audit claim is backed by
   executable cases rather than prose alone.

Resolved fourteenth review findings:

1. Submission now revalidates a persistent 3D attachment's `depthSlice` against the
   logical mip depth of the current replacement allocation. A shrink that invalidates
   the slice fails before native view or encoder creation and before epoch mutation.
2. Buffer-texture copy and texture-upload row layouts now enforce the Web IDL
   `GPUSize32` upper bound before any native call. Tests retain the largest valid
   aligned copy row, the full `rowsPerImage` maximum, and the texture-upload maximum,
   while rejecting `2^32` in both row fields.
3. Render color clears now require exactly four finite sequence components or a
   complete finite `{ r, g, b, a }` dictionary. `GPUStencilValue` is bounded to
   `0xffffffff`; no non-finite, incomplete, or oversized value reaches an encoder.
4. Render pipelines and passes now accept the native depth-only shape while still
   rejecting a descriptor with neither color nor depth/stencil attachment state.
5. Final acceptance itself now runs typecheck, build, diff checking, the headed
   persistent-binding proof, and all 11 ordinary examples. The runner owns the Vite
   lifecycle, so no build occurs while its development server is running.
6. Copy diagnostics describe only current `BufferRegion`/`TextureResource` descriptors.
   Removed raw-buffer, standalone offset/length, and layout-offset shapes are absent
   from both source and executable expected-payload assertions.
7. Bilingual Vision 04/05 now document native-renderable `2d`, `2d-array`, and `3d`
   attachment views, including current-allocation `depthSlice` validation; the final
   documentation audit rejects the contradictory single-2D wording.

Resolved fifteenth review findings:

1. Buffer replacement tests no longer increment only the generic logical allocation
   version while retaining the same native object and stale physical facts. The internal
   candidate-commit transaction atomically replaces `GPUBuffer`,
   size, usage, descriptor, allocation version, and content state, then destroys the old
   candidate. It is not exported from either public package entry point. BindSet coverage
   observes distinct native identity, current bounds/usage/alignment failures, and a
   repaired retry that binds the replacement candidate itself.
2. Final acceptance always preflights, starts, and stops its own Vite server. The former
   external-server success branch is removed. This checkpoint still used a separate
   unavailable-browser target override; the sixteenth-review fix below replaces that
   override with first-class evidence in the normal acceptance sequence.
3. Final acceptance added one post-sequence HEAD and clean-tree snapshot after browser,
   focused/full Mocha, and stress work. Its requirement text overstated this as a check
   after every gate; the sixteenth-review fix below narrows the claim to the evidence
   actually collected.
4. Copy diagnostic expectations now state direction-dependent layout requirements,
   optional texture-only origins/mips/aspects, all three native texture aspects, and the
   distinct buffer-to-buffer size rule. They no longer claim every copy needs both linear
   layouts or that only `all` is supported.

A further new isolated reviewer must re-review these fixes and the remaining Goal
surface. This section is not an approval until that reviewer reports no unresolved
correctness finding.

Resolved sixteenth review findings:

1. Buffer `UploadCommand` now requires `GPUBufferUsage.COPY_DST` at construction and
   revalidates it against the current replacement allocation during queue preflight,
   before any queue write, submission, or logical content effect.
2. Every buffer endpoint in all four `CopyCommand` directions now revalidates its
   current `COPY_SRC` or `COPY_DST` usage together with current range validation before
   command encoder creation.
3. Frozen named dynamic offsets remain immutable command data, but every draw and
   dispatch now reapplies those native offsets to the current replacement allocation's
   effective range and device alignment limits before encoding.
4. The unavailable-browser case is now a first-class `negativeBrowserTarget` result in
   the same normal managed-server acceptance lifecycle. The environment override and
   second independent full-run path are removed. Overall acceptance requires that probe,
   server shutdown, and one final same-commit clean-tree snapshot after the complete
   execution sequence; the report no longer claims a clean snapshot after each gate.

The same-root allocation audit also covered every remaining `BufferRegion` command
consumer. Draw vertex/index bindings, draw/dispatch indirect arguments, ordered
`ReadbackCommand` sources, and query-resolve destinations now revalidate current bounds,
role usage, and operation-specific alignment in each command's `assertUsable()` path.
These checks precede encoder, staging-copy, queue, submission, and logical content
effects. This proactive coverage is separate from the four reviewer findings.

The first fifteen review rounds contained 50 reproduced or source-verified actionable
findings. The sixteenth review adds four, for 54 reviewer findings fixed before the next
fresh-context approval. Proactive same-root cases are recorded separately rather than
inflating that reviewer count.

## Verification Record

Prior v9 revalidation evidence before the tenth review is retained only as diagnostic
history. It is not final acceptance because the old report identified HEAD while the
audited working tree was dirty:

- fixed-baseline executable parity: 11/11 capability rows
- official binding matrix: 6/6 rows
- native GPU copy matrix: 4/4 directions
- historical type disposition: 18/18
- production emit: 102/102 JavaScript and 102/102 declarations, exact bytes/hashes
- declaration/member manifest: 4,717 AST nodes
- examples: 11 ordinary examples and 3 legacy examples
- diagnostics: schema v5, 0 unexpected baseline-code losses
- Vision diagnostics: 196/196 implemented and documented codes; every bilingual module matched
- official GPUWeb main source: 847,267 bytes; six binding/query enum rows, the complete
  `GPUTextureFormat` enum, and required native markers passed
- official GPUWeb copy-rules source: 27,111 bytes; depth/stencil, multisample, and
  compatibility compressed-copy markers passed
- focused acceptance Mocha: 251/251 passing, 0 pending
- headed binding browser: Chrome 150.0.7871.115, Apple Metal 3, passed
- ordinary browser matrix: 11/11 nonblank examples, zero console/page/request failures
- GPU-operation and submission-native provenance browser matrices: passed
- steady-state binding gate: passed
- AST public members: 357 Goal-start / 173 historical methods / 378 final; 21 missing
  and 10 changed Goal-start contracts classified
- reviews before final re-review: 50 actionable findings reproduced or source-verified and fixed
- `npm test`: 798 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed
- `npm run build`: passed
- no-server acceptance: non-zero `ERR_CONNECTION_REFUSED`

Post-tenth-review pre-commit verification:

- native provenance source/docs suites: 11/11 passing, exact 41-site inventory
- sampler `[Clamp] unsigned short` focused contract: passing for lower-bound
  post-normalization, fractional, ties-to-even, upper-clamp, NaN, and infinities
- structural fixed-history runner: passed while still reporting `incomplete`; target
  evidence included HEAD, dirty porcelain entries, and their hash
- dirty-tree acceptance probe: rejected immediately with
  `acceptance requires a clean Git working tree`
- current official-source probes: all three GPUWeb sampler markers and all three WHATWG
  integer-conversion markers present
- `npm test`: 798 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed
- `npm run build`: passed
- headed acceptance is intentionally not rerun until the reviewed tree is committed and
  therefore eligible for the clean-tree gate

Post-eleventh-review pre-commit verification:

- all four review regressions reproduced before their fixes and passed afterward
- combined resource-view, texture, supporting-object, copy, epoch, and pipeline suites:
  118/118 passing
- fixed-history structural runner: passed while correctly reporting `incomplete` on
  the dirty tree; production emit was 102/102 JavaScript and 102/102 declarations with
  4,717 declaration/member signatures
- focused acceptance inventory: 251/251 passing, 0 pending
- `npm test`: 798 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed, including the canonical WebGPU declaration consumer
- `npm run build`: passed for package and all examples
- native provenance inventories: exact 16 allocation sites and exact 41 submission/
  persistent-binding sites
- `git diff --check`: passed

Post-twelfth-review pre-commit verification:

- all six review findings reproduced with 10 failing assertions before implementation;
  the expanded focused regression set passed 112/112 after the fixes
- fixed-history structural runner: 11/11 capability rows, all behavior-title contracts,
  all bilingual documentation checks, exact 102/102 JavaScript and 102/102 declaration
  emit parity, and 4,717 declaration/member signatures passed
- focused acceptance inventory: 346/346 passing, 0 pending
- `npm test`: 800 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed, including the canonical WebGPU declaration consumer
- `npm run build`: passed for the package and all 14 runnable examples
- native provenance inventories: exact 16 allocation sites and exact 41 submission/
  persistent-binding sites after source-line reindexing
- current GPUWeb source marker probe: all nine newly locked render-view, transient,
  depth-clear, alignment, and integer-domain markers present
- `git diff --check`: passed

Post-thirteenth-review pre-commit verification:

- both P1 defects reproduced together as exactly 2 failing regressions before the fix;
  the same depth/BindSet suites passed 32/32 after a fresh package emit
- depth-clear coverage now executes default `1`, explicit `0` and `1`, `NaN`, positive
  and negative infinity, and both out-of-range directions
- mixed BindSet validation/runtime-disposal evidence preserves validation as primary and
  lifecycle recheck as the second immutable incident outcome
- fixed-history structural runner: 11/11 capability rows, all behavior-title contracts,
  bilingual documentation checks, production emit parity, and declaration/member
  inventories passed
- focused acceptance inventory: 348/348 passing, 0 pending
- `npm test`: 802 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed, including canonical WebGPU declarations
- `npm run build`: passed for the package and all 14 runnable examples
- `git diff --check`: passed

Post-fourteenth-review pre-commit verification:

- all seven findings were source-verified; the new regression set produced eight
  expected failures before implementation because depth-only rendering was locked at
  both the integrated pass/pipeline boundary and the pipeline boundary itself
- the five directly changed behavior suites passed 97/97 after a fresh package emit;
  the expanded fixed acceptance inventory passed 369/369 with zero pending cases
- native provenance and texture-resize documentation audits passed 10/10 after the
  unchanged 41-call-site inventory was reindexed and the obsolete single-2D assertion
  was replaced
- fixed-history structural parity passed all 11 capability rows, every behavior-title
  contract, bilingual documentation checks, exact production emit parity, and the
  declaration/member inventories while correctly reporting `incomplete` on a dirty tree
- `npm test`: 810 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed, including canonical WebGPU declarations
- `npm run build`: passed for the package and all 14 runnable examples
- `git diff --check`: passed
- managed-server headed acceptance is intentionally deferred until the reviewed tree is
  committed and therefore eligible for the clean-tree gate

Clean checkpoint acceptance at `7c6e722102b10b783692174d8593fbb786072423`:

- runner verification: `acceptance` / `passed`; the audited commit and empty porcelain
  inventory were recorded before any expensive gate
- live GPUWeb main source: 847,267 bytes, SHA-256
  `932662674acc613000f29cb1b087d8f5e66156e9b37f7ea0ba3eed9130c71283`; all six
  binding/query enum rows, all 101 texture formats, and 48 required native markers
  passed
- live copy-rules source: 27,111 bytes, SHA-256
  `ff03e128d21f18ecbb30b9fea9e3fbd61718c73cc6636ace718907a4cebcf1d8`;
  live Web IDL source: 692,999 bytes, SHA-256
  `d571871f07a5c992d354d985a02361a9e005bec0748213a66beaee3d10202ced`
- runner-owned command gates: `npm run typecheck` passed in 5,892 ms, `npm run build`
  passed in 5,817 ms, and `git diff --check` passed in 14 ms
- managed Vite server became ready in 238 ms, served both headed browser gates, and
  exited normally; its complete managed lifecycle was 26,247 ms and port 4173 was
  closed afterward
- headed Chrome 150.0.7871.115 on Apple Metal 3 passed the persistent-binding probe;
  the ordinary example matrix passed 11/11 with nonblank pixel assertions and zero
  console, page, request, or matrix failures
- focused acceptance: 369/369 passing, zero pending, and zero missing required titles
- complete suite: 812 tests, 810 passing, zero failures, and only the two exact
  browser/final-acceptance gate identities pending
- steady-state gate: 20,000 + 20,000 cycles passed at observed 1.16 and 0.74
  microseconds per cycle
- explicit unavailable browser URL: non-zero exit with `ERR_CONNECTION_REFUSED`
- the runner stopped its child server; the working tree and port 4173 were clean after
  acceptance

Post-fifteenth-review pre-commit verification:

- the real buffer-allocation, copy-diagnostic, and final-runner regressions produced three
  expected failing cases before implementation; the existing resource assertion was then
  exercised explicitly rather than accepted through an unrelated title filter
- every suite using the allocation-replacement test transaction, plus copy and structural
  parity, passed 82/82; only the explicitly disabled final-acceptance gate remained pending
- fixed-history structural parity passed all capability, public-surface, documentation,
  production-emit, and behavior-title contracts; the current declaration manifest contains
  4,718 nodes while the public class-member inventory remains 378
- the first complete-suite run rejected the stale exact native-allocation source location;
  the 16-site provenance inventory was re-derived and passed after updating `buffer.ts:536`
- `npm test`: 811 passing, 2 exact acceptance/browser pending identities
- `npm run typecheck`: passed, including canonical WebGPU declarations
- `npm run build`: passed for the package and all 14 runnable examples
- clean-commit headed acceptance and the next isolated no-findings review remain pending

Clean checkpoint acceptance at `95c4f3dd19a43a3c135786a6fddc3498f22e13dd`:

- runner verification: `acceptance` / `passed`; start and final target commit both
  matched `95c4f3d`, and both working-tree snapshots were empty
- live GPUWeb main, copy-rules, and Web IDL sources matched the previously recorded byte
  lengths and SHA-256 hashes
- runner-owned typecheck, build, and diff gates passed in 6,487 ms, 5,324 ms, and 20 ms
- focused acceptance passed 370/370; the complete suite reported 811 passing and the two
  exact pending browser/final-acceptance gate identities
- both 20,000-cycle steady-state phases passed at 1.42 and 1.00 microseconds per cycle
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed persistent-binding proof and
  all 11 ordinary examples
- the managed Vite server became ready in 235 ms, completed its 19,335 ms lifecycle,
  stopped cleanly, and left the port closed
- a separate unavailable-target run exited non-zero with `ERR_CONNECTION_REFUSED`; the
  sixteenth review correctly rejected treating that second run as evidence inside the
  accepted report

Post-sixteenth-review pre-commit verification:

- the three allocation-revalidation findings produced three expected failures before
  implementation; Upload, Copy, and dynamic-offset focused regressions passed afterward
- the same-root fixed-function, ordered-readback, and query-resolve audit produced three
  additional expected failures before implementation and passed after all command roles
  shared current-allocation validation
- the six directly affected behavior files passed 112/112 after a fresh TypeScript emit
- focused acceptance inventory passed 394/394 with zero pending cases and zero missing
  required titles; native indexed/indirect execution is now part of that focused set
- fixed-history structural parity passed all capability, behavior-title, public-surface,
  documentation, production-emit, and baseline/historical contracts while correctly
  reporting `incomplete` on the dirty tree
- the exact submission-native inventory was re-derived after source movement and passed
  all 41 call sites, including all 23 `command.ts` sites
- `npm test`: 817 passing with only the two exact browser/final-acceptance gate
  identities pending; `npm run typecheck` and the package build passed
- clean commit acceptance remains required before the next isolated no-findings review

The exact no-findings re-review, clean-commit acceptance, final push, and clean-tree
state are recorded only after those gates complete.

## Explicit Non-Goals

- `externalTexture` and external-video frame/task lifetime
- Experimental binding arrays
- Render graphs, tracked dynamic values, or dynamic-value closures
- Full device-loss rehydration or raw device-object tracking
- Global native texture-view caching or `PassSpec.prepare()`
- Automatic resource lookup/matching or authoritative shader reflection
- Material/style/scene/layer or geo-specific policy in Scratch core
- Full future segmented LayoutSpec grammar
- Pipeline-statistics queries
- Migration of the three remaining legacy examples
- Restoration of Hello Map
- Unrelated refactors
