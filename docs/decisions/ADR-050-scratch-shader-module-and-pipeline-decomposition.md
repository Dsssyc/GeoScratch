# ADR-050: Decompose Scratch Shader Modules And Pipelines

## Status

Accepted

## Date

2026-07-24

## Context

The current `Program.modules` model joins caller source parts into one native
shader module during pipeline creation. That prevents native module reuse,
cannot represent distinct vertex and fragment modules faithfully, ties
compilation evidence to a pipeline transaction, and obscures native
`layout: "auto"` and derived bind-group layouts.

The frozen WebGPU baseline exposes reusable `GPUShaderModule` objects,
per-stage module references and constants, optional compilation hints,
asynchronous pipeline factories, auto pipeline layout, and native
`getBindGroupLayout()`.

## Decision Boundary

Phase 2 clean-cuts the old model. No compatibility overload retains
`Program.modules`, pipeline-owned WGSL, pipeline entry-point overrides, or one
pipeline-created shader module.

## Decision

### ShaderModule

`ScratchRuntime.createShaderModule()` is the only public ShaderModule factory
and always returns a Promise. Its descriptor contains a non-empty ordered
`sourceParts` sequence:

```ts
type ShaderModuleSourcePart = Readonly<{
    label?: string
    code: string
    layoutDependencies?: readonly LayoutArtifact[]
}>

type ShaderModuleDescriptor = Readonly<{
    label?: string
    sourceParts: readonly ShaderModuleSourcePart[]
    compilationHints?: readonly ShaderModuleCompilationHint[]
}>
```

Scratch snapshots every part before native issue, joins the parts with one
newline separator, and records per-part hashes, UTF-16 spans, line spans, and
LayoutArtifact ABI/schema identities. The complete source remains available
only on the live ShaderModule object and in transaction-local redaction state.
It does not enter Runtime history, incidents, descriptor evidence, or exported
diagnostic reports.

The acknowledged factory surrounds compilation-hint layout creation,
`createShaderModule()`, `getCompilationInfo()`, and error-scope settlement with
one transaction. A module is published only after every native/scope/lifecycle
outcome settles and its compilation report has no error messages. Warnings and
info messages remain bounded facts and do not reject the module.

Each successful Scratch ShaderModule owns exactly one native
`GPUShaderModule`. Pipelines reuse that object and never recreate it.
ShaderModule disposal prevents future Program or Pipeline use but does not
pretend to destroy a native object for which WebGPU exposes no destroy method.

Compilation hints are optional performance facts:

```ts
type ShaderModuleCompilationHint =
    | Readonly<{ entryPoint: string }>
    | Readonly<{ entryPoint: string, layout: 'auto' }>
    | Readonly<{
        entryPoint: string
        layout: Readonly<{
            bindLayouts?: readonly BindLayout[]
            immediateSize?: number
        }>
    }>
```

An explicit hint layout creates a native pipeline layout from the supplied
Scratch BindLayouts. Scratch validates descriptor shape, Runtime ownership,
and local limits, but does not claim the browser used the hint and does not
invent a stable mismatch diagnostic when the native API does not expose one.

### Program

Program is a resource-free stage contract:

```ts
type ProgramStage = Readonly<{
    module: ShaderModule
    entryPoint?: string
    constants?: Readonly<Record<string, GPUPipelineConstantValue>>
}>

type ProgramDescriptor = Readonly<{
    label?: string
    vertex?: ProgramStage
    fragment?: ProgramStage
    compute?: ProgramStage
    requiredFeatures?: Iterable<GPUFeatureName>
    requiredLimits?: Readonly<Record<string, GPUSize64 | undefined>>
    requiredLanguageFeatures?: Iterable<string>
    layoutRequirements?: readonly ProgramBufferLayoutRequirement[]
}>
```

At least one stage is required. Render creation requires `vertex`, may use
`fragment`, and ignores no hidden compute source. Compute creation requires
`compute`. The stage module, entry point, and constants are one immutable
pipeline-candidate snapshot. Constants use the native
`GPUPipelineConstantValue` domain and remain stage-specific.

Required features, required limits, WGSL language features, and layout
requirements are checked against the Runtime and selected stage modules.
Alignment-class limits are compared with lower values considered better; all
other current WebGPU limits are compared with higher values considered better.
Unknown limit names and malformed values are structured Program diagnostics.
Layout requirements retain their LayoutArtifact witnesses. A generated
accessor dependency is factual only when the selected ShaderModule source part
declared that artifact.

### Pipeline Layout

Pipeline descriptors use one discriminated layout field:

```ts
type PipelineLayout =
    | Readonly<{
        mode: 'explicit'
        bindLayouts?: readonly BindLayout[]
    }>
    | Readonly<{ mode: 'auto' }>
```

Omitting `layout` means `{ mode: 'explicit', bindLayouts: [] }`. There is no
top-level `bindLayouts` alias. Explicit mode creates one native pipeline layout
and retains the current complete Scratch validation path. Auto mode lowers
exactly to native `layout: "auto"`.

Only an auto-layout pipeline exposes `getBindLayout(descriptor)`. The method is
Promise-only, calls native `getBindGroupLayout()`, observes error scopes and
lifecycle, and caches one wrapper per group. The wrapper retains the native
layout identity and caller-declared binding schema needed by BindSet lowering,
but marks:

```ts
origin: 'native-derived'
validationConfidence: 'native-authoritative'
```

An explicitly created BindLayout marks:

```ts
origin: 'explicit'
validationConfidence: 'scratch-verified'
```

The derived schema is local binding metadata, not shader reflection or a claim
about native layout internals. Native pipeline and bind-group validation remain
authoritative. Repeated derivation for one group must use the same normalized
caller schema; a mismatched schema is rejected rather than being silently
associated with the cached native layout. A derivation that settles after its
Pipeline is disposed releases its wrapper and is not published. Explicit
pipelines reject layout derivation.

### Pipeline Stages And Reports

Render and compute pipeline factories remain Promise-only. They receive
already-acknowledged native ShaderModules from the Program snapshot. Render may
use distinct vertex and fragment modules, and any module may be reused across
stages and pipelines.

A successful pipeline retains an immutable creation report containing the
selected stage, ShaderModule ID and source hash, entry point, and override-key
facts. Module compilation messages remain only on each ShaderModule's
compilation report. Native pipeline errors are redacted against every selected
module's transaction-local source index before bounded retention.

A ShaderModule compilation rejection retains that same bounded, source-free
report on the exact supporting-object incident. Default operation history keeps
only ShaderModule identity, source hash, part count, and hint count; it does not
duplicate compilation messages.

### Optional Fragment

Fragment presence is discriminated by `Program.fragment`:

- no fragment stage means native `fragment` is omitted;
- `targets` and all fragment constants are consequently absent;
- a fragment stage requires an explicit `targets` sequence, which may be
  empty;
- a fragmentless pipeline may retain depth/stencil state and rasterize depth;
- pass compatibility derives color formats from the exact target sequence and
  therefore does not require a color attachment for a fragmentless pipeline;
- alpha-to-coverage is not locally reinterpreted beyond facts Scratch can
  prove; native validation remains authoritative for the complete rule.

Structured diagnostics separately identify a missing vertex stage, forbidden
targets without fragment, missing/invalid targets with fragment, pass layout
incompatibility, ShaderModule lifecycle failures, and native pipeline
failures.

## Consequences

This design establishes:

- Promise-only `ScratchRuntime.createShaderModule()` acknowledgement;
- source-part composition, source hashes, and source-location mapping owned by
  `ShaderModule`;
- `Program` as a resource-free stage and requirement contract referencing
  one or more acknowledged ShaderModules;
- independent vertex, fragment, and compute stage descriptors;
- native ShaderModule reuse across multiple pipelines;
- explicit BindLayouts as the default pipeline layout mode;
- explicit opt-in native auto layout with opaque native-derived BindLayouts;
- compilation hints as optional performance facts without correctness claims;
- optional render fragment stage and an exact no-color-output descriptor; and
- removal of `Program.modules` and every old single-module pipeline
  assumption, without aliases.

All tests, examples, browser probes, public type assertions, and bilingual
vision text move to this one contract in the same phase. The migration is
intentionally source-breaking during `0.x.x`.

## Rejected Directions

- Rejoining distinct source modules behind the public API.
- Recreating a ShaderModule for every pipeline.
- Restoring synchronous public pipeline factories.
- Inserting a dummy fragment shader for depth-only rendering.
- Treating shader reflection as a complete WGSL parser or layout authority.
- Keeping old Program or pipeline descriptors as compatibility overloads.

## Acceptance Evidence

Focused Node and type evidence covers separate modules, reuse, compilation
hints, normalized auto-derived layout caching, mismatched schemas, in-flight
Pipeline disposal, explicit-layout defaults, fragmentless depth/stencil
descriptors, source-free ShaderModule compilation incidents, structured native
failures, and clean-cut rejection of old public descriptors. Browser probes and
all current examples have been migrated to the same source contract; their
headed acceptance execution remains part of Phase 6 and the final parity gate.
