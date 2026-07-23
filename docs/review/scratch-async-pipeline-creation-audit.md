# Scratch Async Pipeline Creation Audit

Status: Complete
Date: 2026-07-12
Decision: ADR-033
Comparison baseline: `0de026b` (last synchronous Scratch pipeline implementation)

ADR-050 supersession, 2026-07-24: the Promise-only pipeline timing decision remains
active, but shader-module creation, source composition, compilation information, and
compilation reports now belong to `ScratchRuntime.createShaderModule()`. Program is an
immutable stage contract, pipeline creation reuses acknowledged native modules, and
pipeline evidence is a source-free creation report. Browser and benchmark consumers
have been statically migrated; their new measurements are deferred to Phase 6. The
ADR-033 inventories and measurements below are retained as historical evidence, not
as a current native call-site inventory.

## Result

The implementation, automated tests, TypeScript declarations, benchmark, and
headed Chrome evidence cover the approved async pipeline slice. This audit does
not claim removal of the top-level legacy renderer or replacement of DEM Layer,
Flow Layer, and Hello GAW. Successive fresh-context adversarial reviews found
and drove RED-test fixes for every issue recorded below. The final isolated
post-remediation review found no actionable defect in the WGSL lexical
redaction and bounded Bloom implementation.

| # | Contract | Implementation evidence | Executable evidence | Status |
| --- | --- | --- | --- | --- |
| 1 | Render and compute factories are symmetric ordinary Promises. | Four runtime methods in `runtime.ts`; shared transaction engine in `pipeline-creation.ts`. | Public type tests and render/compute async suites. | Complete |
| 2 | Only native async pipeline creation is used by Scratch. | One render and one compute async call in `pipeline-creation.ts`; no immediate native call under Scratch. | TypeScript AST source audit in `scratch-async-pipeline-creation-docs.test.js`. | Complete |
| 3 | Every supporting-object scope is issued and popped before the first await. | One uninterrupted issue block with validation/internal/OOM scopes. | Fake timeline tests cover success, throws, malformed values, rejection, and out-of-order settlement. | Complete |
| 4 | A wrapper is returned only after compilation, pipeline, scope, and lifecycle settlement. | `issuePipelineCreation()` joins tagged outcomes; `pipelineLifecycleFailures()` runs before commit. | Pending disposal/device-loss/runtime-loss tests and real Chrome timing probe. | Complete |
| 5 | Direct and subclass construction are closed while classes remain valid `instanceof` targets. | ECMAScript-private construction tokens and non-extensible instances in `pipeline.ts`. | Runtime and public TypeScript constructor tests. | Complete |
| 6 | Program and descriptor state cannot drift after native issue. | Source, constants, layouts, targets, vertex state, depth/stencil, multisample, and labels are snapshotted/frozen first. | Mutation-after-issue render/compute tests. | Complete |
| 7 | Compilation and native-error evidence is immutable, UTF-16 correct, bounded, and source-free. | `pipeline-compilation.ts` uses WGSL Unicode/numeric lexical forms and a lazy 32-KiB-capped sanitizer; pipeline-scoped native prose is sanitized and unscoped runtime device-loss prose is omitted. | LF, CRLF, empty, separator, Unicode/non-BMP identifier, decimal/hex literal, unknown-location, count, byte, immutability, large-source workspace, compilation-echo, pipeline-error-echo, and global/pipeline device-loss tests. | Complete |
| 8 | Stable codes use structural facts, not native prose or settlement order. | `GPUPipelineError.reason`, GPU error class, compilation message type, and transaction stage drive classification. | Fake category tests and real Chrome invalid-WGSL/invalid-descriptor probes. | Complete |
| 9 | Independent failures remain independently inspectable. | Bounded ordered `outcomes` array and multiple-failure envelope. | Concurrent failure tests and real Chrome three-outcome invalid WGSL. | Complete |
| 10 | Pipeline records use honest schema-v2 targets without allocation placeholders or pressure. | Resource/pipeline discriminated unions in `gpu-operation.ts`; pipeline facts in `runtime-diagnostics.ts`. | Schema round-trip, query, pressure exclusion, and resource-regression tests. | Complete |
| 11 | Pending/live/disposed facts and subscribers do not grow with runtime age. | Package-internal WeakMap ownership, current fact registration/removal, bounded recorder, cancellable subscriptions. | Public-surface closure test, 64-cycle test, and 5000-cycle benchmark end at zero current/pending/subscribers. | Complete |
| 12 | Draw and dispatch receive the same executable descriptor state as before. | Existing command code consumes the ready wrapper's unchanged native pipeline and normalized public facts. | Existing command/submission suite plus 11 headed Chrome examples. | Complete |
| 13 | Submission has no pipeline instrumentation or hidden wait. | No pipeline imports or native pipeline/scope/compilation calls in `submission.ts`. | Source exclusion test and benchmark source review. | Complete |
| 14 | Main and compatibility package declarations match emitted JavaScript. | TypeScript source-first package build; both entrypoints export the same classes/types. | TypeScript 6, TypeScript 5.9 WebGPU, package build, and runtime imports. | Complete |
| 15 | Legacy calls remain classified and are not silently awaited or rewritten. | AST consumer allowlist distinguishes `scr.renderPipeline`/`computePipeline` from ScratchRuntime methods. | Consumer audit fails on a new unclassified or awaited legacy call. | Complete |

## Native Scratch Pipeline Call Inventory

Inventory commands:

```bash
rg -n '\.(createShaderModule|createPipelineLayout|getCompilationInfo|createRenderPipelineAsync|createComputePipelineAsync|createRenderPipeline|createComputePipeline)\(' \
  packages/geoscratch/src/scratch
npx mocha tests/scratch-async-pipeline-creation-docs.test.js
```

The AST audit ignores method names inside diagnostics strings and distinguishes
runtime aliases from native device calls.

| ID | Scratch call site | Native operation | Classification |
| --- | --- | --- | --- |
| N1 | `pipeline-creation.ts:126` | `device.createShaderModule()` | Supporting object, scoped validation/internal/OOM evidence. |
| N2 | `pipeline-creation.ts:133` | `device.createPipelineLayout()` | Supporting object, same scoped issue turn. |
| N3 | `pipeline-creation.ts:146` | `shaderModule.getCompilationInfo()` | Independent bounded compilation evidence. |
| N4 | `pipeline-creation.ts:153` | `device.createRenderPipelineAsync()` | Canonical render acknowledgement path. |
| N5 | `pipeline-creation.ts:154` | `device.createComputePipelineAsync()` | Canonical compute acknowledgement path. |

Inventory totals under `packages/geoscratch/src/scratch/`:

- Shader-module creation: 1.
- Pipeline-layout creation: 1.
- Compilation-info query: 1.
- Async render creation: 1.
- Async compute creation: 1.
- Immediate native render creation: 0.
- Immediate native compute creation: 0.
- Submission call sites for any item above: 0.

The similarly named `this.createRenderPipeline()` and
`this.createComputePipeline()` calls in `runtime.ts` are public alias delegation,
not `GPUDevice` calls.

## Public Factory And Constructor Inventory

| Surface | Return/availability | Fact |
| --- | --- | --- |
| `ScratchRuntime.createRenderPipeline()` | `Promise<RenderPipeline>` | Canonical public render factory. |
| `ScratchRuntime.renderPipeline()` | `Promise<RenderPipeline>` | Promise alias only; no alternate path. |
| `ScratchRuntime.createComputePipeline()` | `Promise<ComputePipeline>` | Canonical public compute factory. |
| `ScratchRuntime.computePipeline()` | `Promise<ComputePipeline>` | Promise alias only; no alternate path. |
| Internal `createRenderPipeline(runtime, descriptor)` | Package-internal module function | Not exported from `geoscratch` or `geoscratch/scratch`. |
| Internal `createComputePipeline(runtime, descriptor)` | Package-internal module function | Not exported from package entrypoints. |
| `RenderPipeline` class | Exported type/runtime class | Private token constructor; closed to direct/subclass construction. |
| `ComputePipeline` class | Exported type/runtime class | Private token constructor; closed to direct/subclass construction. |

There is no synchronous overload, compatibility flag, static factory, lazy
wrapper, thenable pipeline, or same-source JavaScript implementation.

## Consumer And Legacy Inventory

`scratch-async-pipeline-consumer-audit.test.js` parses every JavaScript and
TypeScript file under `tests/` and `examples/`. Ordinary consumers must await
the direct call. Tests that intentionally inspect the returned Promise are
explicitly allowlisted and must settle it later.

Modern render example consumers:

| File | Render factory calls |
| --- | ---: |
| `examples/externalImageUpload/main.js` | 1 |
| `examples/indirectExecution/main.js` | 1 |
| `examples/readinessPolicies/main.js` | 6 |
| `examples/scratch_helloTriangle/main.js` | 1 |
| `examples/scratch_helloVertexBuffer/main.js` | 1 |
| `examples/scratch_renderToTexture/main.js` | 2 |
| `examples/scratch_textureSampling/main.js` | 1 |
| `examples/scratch_uniformTriangle/main.js` | 1 |
| `examples/textureResize/main.js` | 1 |

Modern compute example consumers:

| File | Compute factory calls |
| --- | ---: |
| `examples/indirectExecution/main.js` | 1 |
| `examples/scratch_computeReadback/main.js` | 1 |
| `examples/submissionOrder/main.js` | 1 |

Modern test and evidence consumers are fully represented by these files:

- Render: `tests/benchmarks/scratch-async-pipeline-creation.mjs`,
  `tests/browser/scratch-async-pipeline-creation.mjs`,
  `scratch-async-pipeline-contract.test.js`,
  `scratch-bind-dynamic-offsets.test.js`, `scratch-binding-upload.test.js`,
  `scratch-compute-pipeline-async.test.js`,
  `scratch-depth-stencil-attachments.test.js`,
  `scratch-native-indirect-execution.test.js`,
  `scratch-occlusion-query.test.js`, `scratch-pass-submission.test.js`,
  `scratch-pipeline-command.test.js`,
  `scratch-pipeline-lifecycle-bounds.test.js`,
  `scratch-program-layout-requirements.test.js`,
  `scratch-query-set.test.js`,
  `scratch-readiness-fallback-outcomes.test.js`,
  `scratch-readiness-policy-execution.test.js`,
  `scratch-render-pipeline-async.test.js`,
  `scratch-submitted-work-epochs.test.js`,
  `scratch-texture-sampler.test.js`, and `tests/types/public-api.ts`.
- Compute: `tests/benchmarks/scratch-async-pipeline-creation.mjs`,
  `tests/browser/scratch-async-pipeline-creation.mjs`,
  `scratch-async-pipeline-contract.test.js`,
  `scratch-bind-dynamic-offsets.test.js`,
  `scratch-compute-pipeline-async.test.js`,
  `scratch-compute-readback.test.js`,
  `scratch-native-indirect-execution.test.js`,
  `scratch-pipeline-lifecycle-bounds.test.js`,
  `scratch-program-layout-requirements.test.js`,
  `scratch-readiness-fallback-outcomes.test.js`,
  `scratch-readiness-policy-execution.test.js`,
  `scratch-submission-queue-order.test.js`,
  `scratch-submitted-work-epochs.test.js`,
  `scratch-texture-sampler.test.js`, and `tests/types/public-api.ts`.

Explicit legacy/raw consumers remain:

| File | Legacy render calls | Legacy compute calls | Boundary |
| --- | ---: | ---: | --- |
| `examples/1_helloTriangle/main.js` | 1 | 0 | Non-catalogued top-level renderer reference; not rewritten by this goal. |
| `examples/m_flowLayer/steadyFlowLayer.js` | 6 | 1 | Flow Layer remains legacy; its separate flow/DEM layering is preserved. |
| `examples/x_helloGAW/main.js` | 6 | 2 | Hello GAW remains legacy. |
| `tests/types/public-api.ts` | 1 | 0 | Compile-only inventory of the top-level legacy API. |
| `examples/m_demLayer/` | 0 direct | 0 direct | DEM Layer remains legacy but has no direct pipeline factory call. |

The consumer audit rejects a new unclassified `scr.renderPipeline()` or
`scr.computePipeline()` call and rejects awaiting one of these legacy calls,
because that would silently pretend the APIs share semantics.

## Old-To-New Functional Parity

The comparison uses `0de026b:packages/geoscratch/src/scratch/pipeline.ts` as the
last synchronous implementation. Every old descriptor field has one current
snapshot and native-lowering path.

| Old descriptor/behavior | Current representation | Parity evidence |
| --- | --- | --- |
| Render `label` | Wrapper keeps caller label; all three native labels add stable Scratch ID suffixes. | Native-label and long-label tests. The suffix is an intentional provenance addition. |
| `program.modules.join('\n')` | Exact Program source snapshot uses the same join rule before native work. | Source snapshot and module mapping tests. |
| `vertex` / Program vertex entry | Frozen `vertexEntryPoint` lowered to native vertex stage. | Render one-to-one native descriptor test. |
| `fragment` / Program fragment entry | Frozen `fragmentEntryPoint` lowered to native fragment stage. | Render one-to-one native descriptor test. |
| `bindLayouts` order and groups | Frozen ordered layouts lower to one explicit pipeline layout. | Layout identity/order and lifecycle tests. |
| `vertexBuffers` | Deep-frozen layouts/attributes lower without field loss. | Descriptor parity and mutation-after-issue tests. |
| `targets` | Deep-frozen target/blend state lowers without field loss. | Descriptor parity and mutation-after-issue tests. |
| default/render `primitive` | `triangle-list` default plus caller state preserved. | Native descriptor parity test. |
| `depthStencil` | Nested stencil state frozen; full native descriptor preserved. | Native descriptor and mutation tests. |
| `multisample` | Frozen state lowers when provided; native default remains when omitted. | Native descriptor parity and real invalid-count probe. |
| Compute `compute` / Program entry | Frozen `computeEntryPoint` lowers unchanged. | Compute native descriptor test. |
| Compute `constants` | Caller record is cloned/frozen and lowered unchanged. | Constants parity and mutation-after-issue tests. |
| Program/layout validation | Existing validation functions run before operation/native effects. | Zero-native-call local-validation tests and unchanged command suites. |
| Native pipeline used by Draw/Dispatch | Ready wrapper exposes the resolved native pipeline under the same `gpuPipeline` fact. | Draw/dispatch suites and browser examples. |
| `dispose()` usability transition | Still idempotently makes the wrapper unusable; now also removes current fact and records disposal. | Disposal, runtime disposal, and bounded churn tests. |

No target, vertex layout, primitive, depth/stencil, multisample, constants,
entry point, bind layout, Program requirement, feature, limit, command behavior,
or public inspection fact from the synchronous implementation disappeared.
Properties are now read-only snapshots so asynchronous issue cannot observe
later caller mutation.

## Official Specification Review

| Official fact | Scratch decision | Review result |
| --- | --- | --- |
| Async pipeline Promises resolve when ready without additional delay and reject with `GPUPipelineError`; no `GPUError` is dispatched for that pipeline failure. | Native async creation is the ready boundary; rejection reason classifies validation/internal. | Matches [render async](https://gpuweb.github.io/gpuweb/#dom-gpudevice-createrenderpipelineasync), [compute async](https://gpuweb.github.io/gpuweb/#dom-gpudevice-createcomputepipelineasync), and [GPUPipelineError](https://gpuweb.github.io/gpuweb/#gpupipelineerror). |
| Immediate pipeline handles may be invalid and may stall later use/finalization/submission. | Scratch has no immediate fallback. | Matches [pipelines](https://gpuweb.github.io/gpuweb/#pipelines). |
| Compilation message location, order, and content are implementation-defined; offsets and lengths use UTF-16 code units. | Preserve native order and zeros, map only derivable module coordinates, source-sanitize prose, and never derive stable codes from it. | Matches [compilation info](https://gpuweb.github.io/gpuweb/#dom-gpushadermodule-getcompilationinfo). |
| WebGPU promises have no general settlement order guarantee. | Compilation, pipeline, and scope promises are independently tagged and joined. | Matches [promise ordering](https://gpuweb.github.io/gpuweb/#promise-ordering). |
| Current `GPUErrorFilter` includes validation, out-of-memory, and internal. | Supporting shader-module/pipeline-layout creation uses all three nested scopes. | Matches [error scopes](https://gpuweb.github.io/gpuweb/#error-scopes). |
| Immediate object creation can yield invalid internal objects and contagious invalidity. | Supporting objects are scoped; failed candidates are dropped without fake destruction claims. | Matches [invalid internal objects](https://gpuweb.github.io/gpuweb/#invalid-internal-objects-contagious-invalidity). |
| Object labels are implementation-defined debugging aids, not causal proof. | Complete labels go native; bounded copies correlate IDs but are not parsed. | Matches [GPUObjectBase labels](https://gpuweb.github.io/gpuweb/#gpuobjectbase). |

The real Chrome invalid-WGSL probe observed three independent outcomes. This is
consistent with the model above and proves why Scratch must not infer a single
cause from Promise settlement order.

Successive fresh-context adversarial passes found seven correctness defects and
one boundedness risk before finalization: runtime disposal suppressed
simultaneous lifecycle facts; compilation prose, pipeline/scope native errors,
and the global runtime device-loss incident each provided a distinct WGSL echo
path; `_pipelines` exposed mutable ownership; an empty report eagerly built its
redaction index; ASCII-only tokenization missed valid short Unicode identifiers
and leading-dot numeric literals; and the first index representation scaled
temporary heap with complete Program source size. Focused RED tests reproduced
each observable defect. The current implementation accumulates every lifecycle
fact, keeps ownership in a package-only WeakMap, source-sanitizes
Program-scoped prose, omits unscoped global device-loss prose, creates
source-redaction state lazily, matches the WGSL lexical token forms, and caps
that workspace at 32 KiB.

The final isolated post-remediation review found no actionable issue in the
identifier/numeric grammar, UTF-16 and non-BMP handling, global-regex reuse,
Bloom add/query symmetry, bit arithmetic, or workspace ceiling. Conservative
over-redaction remains intentional: Bloom collisions, keywords/reserved words,
or characters accepted by a newer JavaScript Unicode table may remove more
native prose than strictly necessary. They cannot produce a false negative for
an inserted WGSL token under the reviewed implementation. Incidental overlaps
shorter than the explicit token/span thresholds remain outside the defined
source-excerpt contract.

## Allocation And Submission Regression Review

- Resource operation targets retain allocation version, content epoch, logical
  footprint, pressure evidence, and ADR-032 attribution semantics under schema
  version 2. Pipeline targets do not fabricate them.
- `textureResize` now queries `operation.target.kind === 'resource'` and
  `operation.target.resourceId`; this fixes a stale example-only schema-v1 read
  found by the headed browser gate.
- `submission.ts` contains no shader-module creation, pipeline-layout creation,
  immediate/async pipeline call, compilation query, error scope, operation
  begin, or hidden Promise wait.
- Existing Draw/Dispatch lowering, resource access, readiness, submission order,
  readback, and texture replacement examples all pass the real browser matrix.

## Remaining Boundary

This goal does not instrument sampler/query creation, bind-group creation,
readback staging, mapping, command encoding/finalization, queue submission, or
the top-level legacy renderer. Those are separate operation families. The next
candidate remains readback staging and mapping provenance, with failure
semantics first defined through `SubmittedWork`.
