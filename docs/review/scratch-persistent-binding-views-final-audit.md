# Scratch Persistent Binding Views Final Audit

Date: 2026-07-14
Status: Post-twenty-fourth-review fixes; clean acceptance and independent re-review pending
Decisions: ADR-031, ADR-033, ADR-036, ADR-037, ADR-038, ADR-039

## Fixed Evidence

- Goal-start TypeScript baseline: `26c6d8875caea7612e573dfb4e33e1340a016d46`
- Historical pre-TypeScript JavaScript reference: `20bb393df570ff1914a6789e9bd422d59ddfecc8`
- Audit target: `socu/scratch-persistent-binding-views-v1`
- Structural audit: `node tests/audits/scratch-persistent-binding-views-final-parity.mjs`
- Final acceptance: `SCRATCH_FINAL_AUDIT=1 node tests/audits/scratch-persistent-binding-views-final-parity.mjs`
- Native authority: [WebGPU resource binding](https://gpuweb.github.io/gpuweb/#resource-binding), [texture views](https://gpuweb.github.io/gpuweb/#texture-view-creation), [canvas configuration](https://gpuweb.github.io/gpuweb/#canvas-configuration), [copies](https://gpuweb.github.io/gpuweb/#copies), [query sets](https://gpuweb.github.io/gpuweb/#query-sets), [timestamp-write validation](https://gpuweb.github.io/gpuweb/#abstract-opdef-validate-timestampwrites), and [Web IDL integer conversion](https://webidl.spec.whatwg.org/#es-integer-types)

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
`npm run typecheck`, `npm run build`, and `git diff --check`. It executes exactly 446
referenced behavior tests; requires the complete suite to report exactly 853 passing
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
legacy descriptor shapes. ADR-036 through ADR-039 define the clean target state.

## Final Parity Table

| Area | Goal-start TypeScript behavior and public symbols | Historical JavaScript feature inventory | Target clean-cut behavior | Final implementation location | Test evidence | Documentation evidence | Intentional breaking replacement | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime and surface | Async runtime plus independent `Surface` and `SubmissionBuilder` | Same runtime/surface separation | Preserve explicit async runtime, exclusive live canvas-context ownership, and non-resource descriptions | `scratch/runtime.ts`, `surface.ts`, `submission.ts` | Runtime, surface, submission suites | Vision 01, ADR-039, and overview | Preserved and strengthened | Complete |
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
- Final diagnostic code inventory: 201
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
- Vision 01/02/03/04/05/07/08/09, ADR-036/037/038/039, the supersession notices on
  ADR-008/009/010, package exports, tests, examples, and generated declarations agree
  on the final contract.

## Intentional Clean Cuts

- Resource-global buffer layout -> immutable `BufferRegion` layout witness
- Public native texture view/cache -> logical `TextureViewSpec`
- `structuralHash` -> `abiHash` plus `schemaHash`
- Synchronous supporting-object factories -> Promise-only acknowledgement
- Public/direct construction -> runtime factories with closed constructors
- Aliased Surface wrappers for one canvas context -> one explicit live owner
- Lazy submission-time BindSet repair -> explicit allocation-bound `prepare()`
- Descriptor-level/raw dynamic offsets -> command-owned named offsets pre-lowered once
- Whole-buffer/range overloads -> `BufferRegion`
- Diagnostics schema v4 -> schema v5
- Public `RenderPassSpec.createRenderPassDescriptor()` -> internal submission-observed lowering

No compatibility aliases, dual descriptor shapes, background retry, reverse dependency
graph, CPU copy substitute, or hidden submission preparation was retained.

## Fresh-Context Strict Review

Twenty-four isolated review passes have examined the fixed-baseline diff and working tree.
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
Reviews fifteen through twenty-one confirmed allocation-replacement, acceptance,
current-use validation, Surface ownership/authority, and transaction defects. The
twenty-second review confirmed three P1 immutable-contract/native-capability defects and
two P2 lifecycle/texture-capability defects. The twenty-third review confirmed two P1
timestamp/performance-contract defects and one P2 living-document defect. The
twenty-fourth review confirmed one P1 pass-owned query lifecycle defect, two P2 current
documentation defects, and the still-required feature-branch push gate. No Critical
issue was reported.

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
   match it, and an explicit Surface view descriptor must select the configured format or
   a configured compatible view format, preserve the 2D single-subresource shape, all
   aspect and RGBA swizzle, and retain render-attachment usage.
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

The next isolated review of the sixteenth-review fixes did not approve the branch. Its
three actionable findings are recorded and resolved below.

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

Resolved seventeenth review findings:

1. A buffer-backed `CopyCommand` source no longer collapses its `BufferRegion` to the
   parent `BufferResource` during current-use validation. Buffer-to-buffer and
   buffer-to-texture copies revalidate the retained source region against the current
   replacement allocation before readiness, encoder creation, or native copy effects.
2. Render-pass preflight now requires all color attachment regions to be pairwise
   disjoint. The overlap key uses logical texture identity plus mip and selected array
   layer, or the selected `depthSlice` for a 3D view; Surface regions use canvas-context
   identity, so separate wrappers cannot alias one current texture. Distinct 3D slices of
   one texture remain native-valid and executable.
3. A color attachment now requires a color-renderable view format. Depth/stencil
   renderable formats fail with a structured descriptor diagnostic before native view or
   command encoder creation instead of relying on asynchronous WebGPU validation.

The seventeenth-review fixes were accepted on the clean `9fe89ee` checkpoint. The
next isolated review did not approve that checkpoint and reported the Surface
ownership defect below.

Resolved eighteenth review finding:

1. One `GPUCanvasContext` can now have only one live Scratch `Surface` owner. The
   module-private weak claim is acquired before canvas resize, native configure, or
   runtime registration; duplicate claims from the same or another runtime produce
   `SCRATCH_SURFACE_CONTEXT_IN_USE` without native effects. Failed construction rolls
   back an uncommitted claim, and successful disposal unconfigures and releases it so
   an explicit replacement can be created. Submission retains its context-identity
   overlap check as defense against forged JavaScript aliases.

The eighteenth-review ownership fix was accepted on clean checkpoint `aab9630`.
The next isolated review reported the three lifecycle defects below.

Resolved nineteenth review findings:

1. `Surface.dispose()` now completes logical disposal, runtime unregister, and weak
   claim release in `finally`. A non-conforming `unconfigure()` throw becomes
   `SCRATCH_SURFACE_UNCONFIGURE_FAILED` only after those facts commit. Runtime disposal
   retains the first cleanup failure, continues surfaces, pipelines, BindSets, layouts,
   readbacks, resources, diagnostics, and device destruction, then rethrows it.
2. `Surface.configure()` now keeps candidate format, alpha mode, and size local until
   synchronous native success. On synchronous failure it restores the prior canvas
   dimensions when possible, preserves prior committed facts, and emits
   `SCRATCH_SURFACE_CONFIGURATION_FAILED` with the native cause. Managed use additionally
   compares `GPUCanvasContext.getConfiguration()` and canvas size against current Surface
   facts; external configure, unconfigure, or resize drift emits
   `SCRATCH_SURFACE_CONFIGURATION_STALE` before current-texture or encoder effects.
3. Every Surface lifecycle and presentation path verifies exact weak-claim owner
   identity. Forged aliases now emit `SCRATCH_SURFACE_CONTEXT_NOT_OWNED` before
   configure, dispose, current-texture, pass, or encoder effects, even when used as the
   pass's only attachment.

These findings bring the reproduced or source-verified reviewer total to 61. The
`getConfiguration()`-driven external-drift and private-identity cleanup regressions are
recorded as same-root proactive coverage rather than additional reviewer findings.

The nineteenth-review fixes were accepted on clean checkpoint `52b14e4`. The next
isolated review reported the five Surface authority and submission-order defects below.

Resolved twentieth review findings:

1. Pass validation no longer brands a Surface through replaceable public methods or
   public context/runtime fields. Exact receiver state and context ownership come from
   module-private weak records; a forged alias with shadowed methods fails before pass,
   presentation, or encoder effects.
2. `Surface.dispose()` now commits terminal lifecycle state, unregisters, unconfigures,
   and releases the original context claim entirely through private state. Frozen or
   otherwise non-writable public observations cannot strand a live claim.
3. `Surface.configure()` no longer publishes a native candidate through public field
   assignments. It commits one private state record only after native configure,
   complete configuration observation, and exact canvas-size observation succeed;
   observation failure restores and verifies the previous native/canvas state.
4. Surface configuration validation now covers device, format, usage, view formats,
   color space, optional tone mapping, alpha mode, and canvas size. Iterable and
   dictionary inputs are snapshotted, observations are immutable, and pass view
   descriptors may express configured compatible formats and native-valid usage subsets.
5. Submission prepares immutable configuration-version leases for every executable
   Surface after validation and before creating any command encoder. Surface current
   texture/view creation remains an observed `attachment-view` operation, but descriptor
   lowering performs no late public call or second configuration query.

These findings bring the reproduced or source-verified reviewer total to 66. Additional
rollback-verification, canvas-coercion, immutable view-descriptor, and complete native
configuration cases are same-root proactive coverage rather than reviewer findings.

The twentieth-review fixes were accepted on clean checkpoint `fafcfbf`. The next
isolated review reported the three Surface transaction and transient-view defects below.

Resolved twenty-first review findings:

1. `Surface.configure()` now materializes option getters and iterables against the
   call-entry configuration snapshot, then rechecks exact owner, runtime lifecycle, and
   configuration version before canvas or native effects. Reentrant disposal reports the
   disposed owner; reentrant successful configuration invalidates the outer candidate with
   `SCRATCH_SURFACE_CONFIGURATION_STALE` instead of committing stale facts.
2. The checkpoint normalized transient Surface views to exact Surface usage and
   clear/discard instead of narrowing them. The twenty-second review subsequently proved
   that the premise itself violated the Canvas configure contract; this provisional fix
   is superseded by the explicit Surface rejection below.
3. Canvas-size rollback success now requires exact width/height readback after assignment.
   A non-throwing setter that rejects or coerces the rollback is reported truthfully as
   `canvasRestored: false` while logical candidate facts remain uncommitted.

These findings bring the reproduced or source-verified reviewer total to 69.

The twenty-first-review implementation received clean mechanical acceptance at exact
commit `76022adb856be01eae8b3f531652b73d6d061e89`: 422/422 focused tests, 845 passing plus
the two exact pending gates, both TypeScript consumers, all 14 builds, both 20,000-cycle
stress phases, headed Chrome on Apple Metal 3, and all 11 ordinary examples passed. The
next isolated review did not approve that checkpoint and reported the five defects below,
so `76022ad` remains evidence history rather than final approval.

Resolved twenty-second review findings:

1. Surface normalization now rejects any usage containing
   `GPUTextureUsage.TRANSIENT_ATTACHMENT` before canvas resize or native configure, as
   required by `GPUCanvasContext.configure()`. Ordinary TextureResource attachments keep
   native transient allocation/view and clear/discard behavior.
2. Render and compute PassSpec normalized state is now immutable at runtime and in the
   public type contract. Attachment arrays/objects, clear values, depth/stencil facts,
   timestamp writes, and top-level references are locked, while disposal uses private
   lifecycle state. A valid transient texture pass cannot be mutated into store/load
   operations that bypass construction validation.
3. Pipeline creation snapshots normalized Program layout requirements together with its
   source contract. The successful Pipeline privately retains that immutable snapshot,
   and draw/dispatch command preflight consumes it rather than a later replacement of
   `Program.layoutRequirements`.
4. BindSet acknowledgement lifecycle recheck no longer returns after one match. It
   retains runtime disposal, device loss, BindSet/BindLayout disposal, and every distinct
   disposed bound-resource fact in the ADR-defined deterministic order before choosing
   the primary outcome.
5. One-dimensional textures now accept every mip count within the ordinary native
   maximum-mip calculation. The native 1D render-attachment prohibition remains enforced
   independently, and persistent 1D mip views have direct positive coverage.

These findings bring the reproduced or source-verified reviewer total to 74.

The twenty-second-review implementation received clean mechanical acceptance at exact
commit `c8ae0ab018b70e47eff70b998de842699116bc95`: 441/441 focused tests,
848 passing plus the two exact pending gates, both TypeScript consumers, all 14 builds,
both 20,000-cycle stress phases at 1.71 and 1.41 microseconds per cycle, headed Chrome
150.0.7871.115 on Apple Metal 3, and all 11 ordinary examples passed. The next isolated
review did not approve that checkpoint and reported the three defects below, so
`c8ae0ab` remains evidence history rather than final approval.

Resolved twenty-third review findings:

1. PassSpec normalization now rejects equal provided `begin` and `end` timestamp-write
   indices with `SCRATCH_PASS_TIMESTAMP_WRITES_INVALID`. Separate render and compute
   regressions prove rejection while creating the pass, before command-encoder or native
   pass effects, matching the official `Validate timestampWrites` rule.
2. Command construction now snapshots each dynamic BindLayout entry sequence together
   with its immutable native offset sequence. Steady-state validation rechecks current
   allocation alignment and bounds against those snapshots without `filter()`, `sort()`,
   name-map reads, or native sequence reconstruction. The stress detector now observes
   the real `binding` property instead of the nonexistent `entry.binding` path.
3. The active provenance-integration review now labels its consolidation list as
   historical and explicitly records the current schema-v5, Promise-only supporting
   object, and explicit `BindSet.prepare()` replacement. It no longer teaches schema v4
   or lazy bind-group creation as retained current behavior.

These findings bring the reproduced or source-verified reviewer total to 77.

Resolved twenty-fourth review findings:

1. Render and compute `PassSpec.assertUsable()` now revalidate every retained timestamp
   or occlusion `QuerySetResource`. Submission already invokes that contract during its
   complete preflight, so disposal after pass construction fails before attachment-view,
   command-encoder, pass, queue, or logical-write effects. Three regressions independently
   cover compute timestamp, render timestamp, and attachment-only render occlusion use.
2. The command vision now distinguishes submission-scoped attachment views, which are
   lowered from logical `TextureViewSpec` values, from allocation-scoped persistent
   binding views, which only acknowledged BindSet preparation may create. It no longer
   makes the false blanket claim that submission creates no texture views.
3. The living intelligent-friendly review now marks its allocation-only provenance phase
   as superseded and records the acknowledged supporting-object/pipeline, explicit
   `TextureViewSpec`, and `BindSet.prepare()` contracts. It no longer presents inferred
   binding dimensions or deferred supporting objects as current behavior.
4. The reviewer correctly observed that the feature branch was not yet remote. That is
   an ordered completion gate rather than an implementation repair: the Goal requires
   the push only after clean acceptance and an exact no-findings re-review.

These findings bring the reproduced or source-verified reviewer total to 81.

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

Clean checkpoint acceptance at `72d84bc856b0fc70d4d390e4e29d5e5451da5ce2`:

- runner verification was `acceptance` / `passed`; the initial and final repository
  evidence named the same exact commit and an empty working tree
- all capability, public-surface, documentation, production-emit, fixed-baseline, and
  historical JavaScript parity rows passed against the live official sources
- runner-owned typecheck, complete build, and diff checking passed
- focused acceptance passed 394/394; the complete suite reported 817 passing and only
  the two exact browser/final-acceptance gate identities pending
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed persistent-binding proof and
  all 11 ordinary examples; both 20,000-cycle steady-state phases passed
- the integrated unavailable-target probe exited non-zero with
  `ERR_CONNECTION_REFUSED`; the runner stopped its managed Vite server and confirmed the
  same clean repository target after the complete execution sequence
- the subsequent seventeenth isolated review found the three issues recorded above, so
  this checkpoint is evidence history rather than final approval

Post-seventeenth-review pre-commit verification:

- all three review findings first produced exactly three focused RED failures; the Copy
  failure reached the later readiness diagnostic, while both pass cases reached native
  behavior instead of a Scratch diagnostic
- the same three focused tests passed after implementation, including a positive
  submission that binds two different 3D `depthSlice` values from one texture
- the same-root pass audit also covers forged Surface aliases sharing one canvas
  context and submit-time Surface format reconfiguration without increasing the reviewer
  finding count
- the affected copy, pass, depth/stencil, documentation, fixed-history, and native-source
  suites passed after the exact 41-site native inventory was re-derived
- fixed-history structural parity passed every capability, behavior-title, bilingual
  documentation, production-emit, and baseline/historical contract while correctly
  reporting `incomplete` on the dirty tree
- `npm test`: 820 passing with only the two exact browser/final-acceptance gate
  identities pending; `npm run typecheck` and the complete package/example build passed
- clean-commit acceptance and a new isolated review remained required

Clean checkpoint acceptance at `9fe89eea0ce37e01b400603f2e6270e6119d033b`:

- runner verification was `acceptance` / `passed`; initial and final repository
  evidence named the same exact commit and an empty working tree
- live GPUWeb main, copy-rules, and Web IDL sources retained the recorded byte lengths
  and SHA-256 hashes; all six enum rows, all 101 texture formats, and 50 required native
  markers passed
- runner-owned typecheck, complete build, and diff checking passed in 5,808 ms,
  5,175 ms, and 22 ms
- focused acceptance passed 397/397; the complete suite reported 820 passing and only
  the two exact browser/final-acceptance gate identities pending
- both 20,000-cycle steady-state phases passed at observed 1.76 and 1.45 microseconds
  per cycle
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed persistent-binding proof;
  all 11 ordinary examples passed with zero matrix failures
- the managed Vite server started in 236 ms, completed its 19,468 ms lifecycle, stopped
  cleanly, and left port 4173 closed; the unavailable target produced the required
  non-zero `ERR_CONNECTION_REFUSED` result
- the subsequent eighteenth isolated review found the Surface ownership issue recorded
  above, so this checkpoint is evidence history rather than final approval

Post-eighteenth-review pre-commit verification:

- duplicate same-runtime/cross-runtime Surface construction first produced one focused
  RED failure because both candidates reached native configure instead of a Scratch
  diagnostic
- the two ownership regressions and the retained pass overlap/format regressions passed
  4/4 after implementation; the duplicate claim has zero configure/unconfigure side
  effects, failed configure rolls back its claim, and explicit owner disposal permits
  one replacement claim
- fixed-history structural parity passed all capability, behavior-title, bilingual
  documentation, ADR, production-emit, and baseline/historical contracts while correctly
  reporting `incomplete` on the dirty tree
- the exact submission-native inventory passed all 41 call sites after the Surface
  current-texture source location was re-derived
- `npm run typecheck` passed, including the canonical WebGPU declaration consumer;
  the complete package and all 14 runnable examples built successfully
- `npm test` reported 822 passing with only the two exact browser/final-acceptance gate
  identities pending; `git diff --check` passed
- the acceptance runner now locks 399 focused cases and the exact 822 + 2 full-suite
  total; a clean checkpoint and new isolated no-findings review remain required

Clean checkpoint acceptance at `aab9630738010fe110d6a9cfdcf9517dcd65c9b7`:

- runner verification was `acceptance` / `passed`; initial and final repository
  evidence named the same exact commit and an empty working tree
- live GPUWeb main, copy-rules, and Web IDL evidence passed all enum, texture-format,
  and 50 required native markers with the recorded source hashes
- runner-owned typecheck, complete build, and diff checking passed in 5,278 ms,
  4,966 ms, and 19 ms
- focused acceptance passed 399/399; the complete suite reported 822 passing and only
  the two exact browser/final-acceptance gate identities pending
- both 20,000-cycle steady-state phases passed at observed 1.75 and 1.46 microseconds
  per cycle
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed persistent-binding proof;
  all 11 ordinary examples passed with zero matrix failures
- the managed Vite server started in 235 ms, completed its 18,398 ms lifecycle, stopped
  cleanly, and left port 4173 closed; the unavailable target produced the required
  non-zero `ERR_CONNECTION_REFUSED` result
- the subsequent nineteenth isolated review found the three lifecycle issues recorded
  above, so this checkpoint is evidence history rather than final approval

Post-nineteenth-review pre-commit verification:

- the five reviewer regressions first produced exactly five targeted RED failures:
  stale reconfiguration metadata, forged lifecycle alias, direct unconfigure cleanup,
  runtime-disposal continuation, and forged sole pass attachment
- a sixth proactive RED proved direct native configure/unconfigure and canvas resize
  drift reached `getCurrentTexture()` without a Scratch diagnostic
- a seventh proactive RED proved mutating public context and lifecycle observations
  could make a live owner appear replaceable and strand its original private claim
- all seven new regressions plus the strengthened initial-configure rollback case passed
  8/8 after implementation; Surface observations are now read-only in TypeScript,
  managed use rejects public identity drift, and private lifecycle facts govern claim
  replacement and disposal cleanup
- current GPUWeb source and installed canonical types confirm
  `GPUCanvasContext.getConfiguration()`; the final acceptance source gate now locks the
  configure commit and unconfigure clear algorithms instead of repeating the superseded
  claim that current configuration cannot be queried
- fixed-history structural parity passed every capability, behavior-title, bilingual
  documentation, ADR, production-emit, and baseline/historical contract while correctly
  reporting `incomplete` on the dirty tree
- the expanded submission-native inventory passed all 42 classified call sites,
  including synchronous Surface configuration inspection
- `npm run typecheck` passed, including the canonical WebGPU declaration consumer;
  the complete package and all 14 runnable examples built successfully
- `npm test` reported 829 passing with only the two exact browser/final-acceptance gate
  identities pending
- `git diff --check` passed; clean-commit acceptance and a new isolated no-findings
  review remain required

Clean checkpoint acceptance at `52b14e443b6b9b8464eaa99462d5a0f5f0e5c3d8`:

- runner verification was `acceptance` / `passed`; initial and final repository
  evidence named the same exact commit and an empty working tree
- runner-owned typecheck, complete build, and diff checking passed in 6,677 ms,
  5,287 ms, and 16 ms
- focused acceptance passed 406/406; the complete suite reported 829 passing and only
  the two exact browser/final-acceptance gate identities pending
- both 20,000-cycle steady-state phases passed at observed 1.77 and 1.49 microseconds
  per cycle
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed persistent-binding proof;
  all 11 ordinary examples passed with zero matrix failures
- the managed Vite server started in 234 ms, completed its 22,139 ms lifecycle, stopped
  cleanly, and left port 4173 closed; the unavailable target produced the required
  non-zero `ERR_CONNECTION_REFUSED` result
- the subsequent twentieth isolated review found the five Surface authority and
  submission-order issues recorded above, so this checkpoint is evidence history rather
  than final approval

Post-twentieth-review pre-commit verification:

- the five reviewer scenarios first produced six expected focused failures around
  public-method branding, frozen observation commits, incomplete configuration facts,
  and late configuration reads; two same-root descriptor/diagnostic cases also failed
  before implementation
- Surface and render-submission regressions now pass 53/53, including verified native
  rollback, silently coerced canvas size rejection, two-Surface pre-encoder preparation,
  immutable view descriptors, and configured alternate view-format execution
- focused acceptance passed 417/417 with zero pending cases and every newly required
  behavior title present; `npm test` reported exactly 840 passing with only the two
  acceptance/browser gate identities pending
- fixed-history structural parity passed every capability, behavior-title, bilingual
  documentation, ADR, production-emit, and baseline/historical contract while correctly
  reporting `incomplete` on the dirty tree
- the exact submission-native inventory passed all 43 classified call sites; Surface
  configuration observation remains one deterministic preflight site, while current
  texture and view creation are attributed to the submission `attachment-view` stage
- `npm run typecheck` passed both the TypeScript 6 and canonical TypeScript 5.9/WebGPU
  declaration consumers; package build and generated declarations passed

Clean twentieth-review checkpoint acceptance (`fafcfbf`):

- initial and final repository evidence named exact commit
  `fafcfbf9045d2f5200797f0ae08be0e2b0846da2` with an empty working tree
- runner-owned typecheck, complete build, and diff checking passed in 6,784 ms,
  5,556 ms, and 15 ms
- focused acceptance passed 417/417; the complete suite reported 840 passing and only
  the two exact browser/final-acceptance gate identities pending
- both 20,000-cycle steady-state phases passed at observed 1.91 and 1.52 microseconds
  per cycle
- Chrome 150.0.7871.115 on Apple Metal 3 passed the headed proof; all 11 ordinary
  examples passed, the unavailable target failed with `ERR_CONNECTION_REFUSED`, and
  the managed Vite server completed its 25,580 ms lifecycle and left port 4173 closed
- the subsequent twenty-first isolated review found the three transaction/transient
  issues recorded above, so this checkpoint is retained as history rather than approval

Post-twenty-first-review pre-commit verification:

- all five new reviewer regressions first failed for their intended reasons: stale-owner
  and stale-version candidates reached the old path, rollback falsely reported success,
  transient Surface defaults stored content, and submission missed usage drift
- the same five regressions now pass without weakened assertions; exact owner disposal,
  configuration-version invalidation, rollback readback, transient view usage, and
  pre-encoder submission rejection are all directly observed
- focused acceptance passes 422/422 with zero pending cases and every required behavior
  title present; `npm test` reports exactly 845 passing with only the two exact
  acceptance/browser gate identities pending
- `npm run typecheck` passes both TypeScript 6 and the canonical TypeScript 5.9/WebGPU
  declaration consumer; `npm run build` emits the package and all 14 runnable examples
- fixed-history structural parity passes all capability, official binding, native copy,
  behavior-title, documentation, example, and source-inventory gates while correctly
  reporting `incomplete` for the dirty pre-commit tree
- the native inventory still contains exactly 43 classified call sites, including the
  reindexed Surface transaction/preparation sites
- clean-commit acceptance and a fresh isolated exact no-findings review remain required

Post-twenty-second-review pre-commit verification:

- the five new reviewer regressions first failed for their intended reasons: Canvas
  transient-attachment usage reached native configuration, mutable PassSpec attachment
  descriptors bypassed submission validation, live Program requirement replacement
  weakened an existing pipeline contract, BindSet preparation retained only one of
  several concurrent lifecycle failures, and valid one-dimensional mip chains were
  rejected before native texture creation
- seven public type assertions also failed before implementation because normalized
  pass attachment, timestamp-write, and descriptor collections were still mutable
- all five targeted regressions now pass 5/5; the complete affected Surface, PassSpec,
  BindSet, resource-view, Program-requirement, pipeline-command, texture-resize, and
  final-contract collection reports 143 passing with only its final-acceptance identity
  pending, without weakened assertions
- `npm run typecheck` passes both the TypeScript 6 package consumer and the canonical
  TypeScript 5.9/WebGPU declaration consumer; immutable pipeline snapshots and deeply
  locked PassSpec observations are part of the public contract
- `npm test` reports exactly 848 passing with only the two exact browser/final-acceptance
  gate identities pending; the submission-native inventory passes all 43 classified
  call sites
- `npm run build` emits the package and all 14 runnable examples; fixed-history
  structural parity passes the expanded capability, official-source, behavior-title,
  bilingual-documentation, ADR, production-emit, and historical-baseline contract while
  correctly reporting `incomplete` for the dirty pre-commit tree
- clean-commit acceptance and a fresh isolated exact no-findings review remain required

Post-twenty-third-review pre-commit verification:

- separate compute and render duplicate-index regressions first failed 0/2 because
  PassSpec creation accepted equal timestamp slots; both now pass before encoder or
  native-pass effects with the structured timestamp-write diagnostic
- correcting the stress detector from nonexistent `entry.binding` to the actual
  `binding` property first failed the short steady-state gate with
  `steady-state binding work sorted bindings into native order`; the Command-owned
  entry/native-offset snapshot implementation then restored the gate without weakening
  its zero-sort assertion
- the living-review contract check first failed on the missing current-replacement
  marker; it now passes and rejects both obsolete schema-v4/lazy-binding bullet forms
- the affected QuerySet, dynamic-offset, performance, and final-contract collection
  reports 42 passing with only its final-acceptance identity pending; fixed-history
  structural parity locks the 443-test focused acceptance count, confirms every named
  behavior contract, and includes the new official timestamp-write distinctness marker
  while correctly reporting `incomplete` on the dirty tree
- `npm run typecheck` passes both TypeScript consumers; `npm test` reports exactly
  850 passing with only the two exact browser/final-acceptance identities pending
- `npm run build` emits the package and all 14 runnable examples; the exact native
  inventory passes all 43 call sites after reindexing the three shifted command sites
- clean-commit acceptance and a fresh isolated exact no-findings review remain required

Post-twenty-fourth-review pre-commit verification:

- three pass-owned QuerySet regressions first produced two missing diagnostics and one
  render path that created an attachment view before rejecting a disposed occlusion set;
  all three now pass with zero native view, encoder, pass, queue, or submission effects
- the strengthened documentation audit first failed both the living-review and
  submission-view-ownership contracts; both now pass, and the older resize-documentation
  test was updated after it correctly exposed its obsolete blanket no-view assertion
- the complete affected query, pass, readiness, indeterminacy, and final-contract set
  passed 97 tests with only the explicit final-acceptance identity pending before the
  full-suite run
- `npm run typecheck` passes both TypeScript consumers; `npm test` reports exactly 853
  passing with only the two exact browser/final-acceptance identities pending
- `npm run build` emits the package and all 14 runnable examples; fixed-history
  structural parity locks the 446-test focused acceptance count and passes every
  capability, official binding, native-copy, behavior-title, bilingual-documentation,
  ADR, production-emit, and historical-baseline gate while correctly reporting
  `incomplete` for the dirty pre-commit tree
- `git diff --check` passes; clean-commit acceptance, a new isolated exact no-findings
  review, final audit closure, and the required feature-branch push remain pending

The exact no-findings re-review, new clean-commit acceptance, final push, and clean-tree
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
