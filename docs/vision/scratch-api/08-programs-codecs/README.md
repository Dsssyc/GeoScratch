# Programs, Layout Codecs, And Shader Composition

Status: Vision draft
Date: 2026-07-24

## Decision

Shader-facing APIs should be split into explicit artifacts:

- `LayoutSpec` describes logical data shape.
- `LayoutArtifact` records computed offsets, stride, padding, alignment mode, usage lowering, separate `abiHash` / `schemaHash` identifiers, and immutable canonical signatures.
- `LayoutCodec` is the preparation artifact built from a layout: CPU writers, readback views, and WGSL accessor modules.
- `ShaderModule` owns composed WGSL source parts, LayoutArtifact dependencies,
  compilation hints, one acknowledged native `GPUShaderModule`, and bounded
  compilation evidence.
- `Program` is an immutable, resource-free stage and requirement contract that
  references acknowledged ShaderModules.
- `Pipeline` is stable WebGPU executable state for one Program plus render or
  compute pipeline state.
- `BindSet` supplies concrete resources.
- `Command` invokes a pipeline with bind sets, resource access declarations, readiness policy, and draw/dispatch/copy parameters.

The scratch core must not introduce a `Material` abstraction. In scene engines, material commonly bundles program, data parameters, visual surface semantics, lighting assumptions, and object assignment. That coupling is useful above the kernel but wrong inside scratch: scratch must support graphics and compute equally, and `geo` must be free to build map, globe, Cartesian, mixed-space, tiled, streamed, and one-off GPU workloads without inheriting a render-material mental model.

## Target Flow

```text
LayoutSpec
    -> LayoutArtifact
    -> LayoutCodec
        -> CPU writer / uploader input
        -> readback views
        -> WGSL accessor module

user WGSL + generated accessor modules
    -> ShaderModule
    -> Program stage contract + bind-layout requirements
    -> Pipeline
    -> Command
    -> Submission
```

This keeps code generation and runtime execution connected without hiding behavior:

- Layout and shader helpers may be generated ahead of runtime, at build time, or lazily during runtime initialization.
- Submission-time execution consumes explicit artifacts. It must not depend on ad-hoc string generation or hidden shader mutation.
- Generated artifacts must be inspectable, cacheable by canonical ABI/schema signatures, and diagnosable through the shared `ScratchDiagnostic` envelope in `09-diagnostics-validation`. Short hashes alone are not compatibility proof.

`ShaderModule` and `Program` discrimination are closed with their exact built-in prototypes and
module-private `WeakMap` state record. That record is authoritative for runtime
ownership and disposal. Public `Program.runtime`, `Program.id`, and
`Program.isDisposed` are immutable observations rather than writable authority.
Public `assertRuntime()` and `assertUsable()` are convenience validation methods, not
internal authority dispatch points; pipeline internals read the private state and
lifecycle epoch directly, so own-property method shadowing cannot suppress ownership
or disposal checks.
`LayoutCodec` separately keeps its exact prototype plus module-private `WeakSet` brand.
Every Pipeline creation path and every explicit Shader inspection input or option calls
`isProgram()` before invoking internal ownership validation or reading stages and
layout requirements. Every selected stage then proves the exact ShaderModule brand,
Runtime ownership, and lifecycle. Render
and compute Pipeline objects are likewise recognized only by their exact prototype and
module-private state-map record before Command construction. Public `instanceof`,
similarly shaped methods, replacement of `Symbol.hasInstance`, subclassing, and
`Object.create(Program.prototype)` / `Object.create(LayoutCodec.prototype)` cannot
inject caller-authored facts into those paths.

Program remains a caller-owned shader contract. Program construction takes an
immutable snapshot of every stage, constant map, requirement iterable, and
LayoutArtifact witness, so later caller mutation cannot alter any future Pipeline.
Each render or compute Pipeline creation captures one Program/Runtime lifecycle stamp
and forms a candidate-local immutable snapshot before native work. It validates
every referenced ShaderModule and requirement, normalizes its own descriptor, and
rechecks the stamp before native issue and before asynchronous commit. Disposal before
native issue reports `SCRATCH_PROGRAM_DISPOSED` without recreating or recompiling a
ShaderModule. Automatic retry is not performed. This is an internal acknowledgement
transaction, not a public `prepare()` method, mandatory state machine, lock held across
caller code, or caller-visible preparation state.

## LayoutCodec

`LayoutCodec` is not a resource and not a scheduler feature. It is a bridge between a typed layout and the byte-level facts needed by CPU, WGSL, and readback.

Outputs:

- `FixedLayoutArtifact` or `RuntimeLayoutArtifact`: recursive type facts,
  offsets, element/column stride, padding, explicit member layout, alignment,
  fixed length or runtime-tail facts, structured usage compatibility,
  capability requirements, `abiHash`, `schemaHash`, and canonical signatures
- CPU writer: packs logical values into GPU-aligned bytes while skipping padding
- upload view: the contiguous byte range that can be sent with one upload command
- readback view factory: creates typed, `DataView`, strided, or explicitly deinterleaved views from returned bytes
- WGSL accessor module: generated structs/functions/constants for safe shader-side field access
- buffer-view contract and WGSL constants: explicit source/target types, byte
  range, alignment, pointer path, and required language features for
  `bufferView`, `bufferArrayView`, and `bufferLength`
- diagnostics: unsupported field format, incompatible usage, non-representable alignment, byte-length mismatch, or unsafe strided view requests, reported through `ScratchDiagnostic`

One recursive model covers the complete scoped host-shareable family: scalar,
vector, floating matrix, fixed array, structure, final-member runtime array,
storage atomic, explicit member `@align` / `@size`, and opaque fixed/runtime
buffer roots. Exact binary16 conversion is part of the CPU ABI. The TypeScript
descriptor grammar excludes statically invalid nesting; runtime validation
applies the same constraints to JavaScript and dynamic input.

Only fixed artifacts publish a total `byteLength` and `stride`. Runtime
artifacts publish a fixed prefix and minimum binding size, then require an
explicit `runtimeElementCount` to produce a concrete host byte range. This
extent flows through packing, writing, upload/readback views, BufferRegion
witnesses, Program minimum binding sizes, and command range validation.

The high-performance CPU path is:

```text
source AoS/SoA data
    -> CPU writer fills one GPU-aligned ArrayBuffer or leased staging span
    -> one explicit UploadCommand writes the contiguous range
```

This avoids one CPU-to-GPU operation per structure and also avoids a GPU-side repack pass that can double peak VRAM. If an external schema is already GPU-aligned, the writer can use a direct view or a bulk copy; otherwise it writes fields into the aligned layout and skips padding on CPU.

Raw packed bytes remain an escape hatch, but they are not the default authoring model. Forcing authors to manually mirror WGSL padding in shader code is a correctness hazard, especially when code is AI-assisted.

The artifact keeps one common host-shareable ABI. Every
`usageCompatibility` member is an immutable object, not a Boolean: it reports
compatibility, reasons, required device features, required language features,
and mutable-storage requirements. A named `portable` uniform contract applies
the core uniform-address-space constraints. A named
`uniform_buffer_standard_layout` contract retains the same ABI while deriving
that language-feature requirement. Neither contract silently selects a second
packing.

ABI and schema identities cover the recursive type and capability contract.
Typed Program requirements default to exact schema compatibility; native
binding independently validates ABI, usage, range, and alignment. Short hashes
are bounded identifiers, so immutable canonical signatures remain the final
equality evidence.

## ShaderModule And Program

`ShaderModule` owns code and code-adjacent compilation facts. `Program` owns
only immutable stage references and requirements. Neither owns concrete
resources or scene meaning.

A ShaderModule declares:

- ordered WGSL source parts, each with an optional label
- LayoutArtifact dependencies for generated accessor provenance
- optional entry-specific compilation hints using `"auto"` or an explicit
  native pipeline layout

A Program declares:

- optional `vertex`, `fragment`, and `compute` stages, with at least one stage
- one acknowledged ShaderModule per selected stage
- optional entry point and stage-specific override constants
- required device features and limits
- required WGSL language features
- buffer layout requirements and LayoutArtifact witnesses

Example shape:

```ts
const pointCodec = scratch.layoutCodec(pointLayout, {
    usage: ['storage', 'readback'],
})

const pointBuffer = await scratch.buffer({
    label: 'points',
    size: pointCodec.artifact.stride * pointCount,
    usage: ['storage', 'copyDst', 'copySrc'],
})

const points = pointBuffer.region({
    layout: pointCodec.artifact,
})

const simulateModule = await scratch.createShaderModule({
    label: 'simulate points module',
    sourceParts: [
        {
            label: 'Point accessors',
            code: pointCodec.wgslAccessors({ namespace: 'Point' }),
            layoutDependencies: [pointCodec.artifact],
        },
        {
            label: 'simulation',
            code: scratch.wgsl`
            @group(0) @binding(0)
            var<storage, read_write> points: array<PointStorage>;

            @compute @workgroup_size(64)
            fn main(@builtin(global_invocation_id) id: vec3u) {
                let i = id.x;
                let p = Point_readPosition(points, i);
                Point_writePosition(points, i, p);
            }
        `,
        },
    ],
})

const simulateProgram = scratch.createProgram({
    label: 'simulate points',
    compute: { module: simulateModule, entryPoint: 'main' },
    layoutRequirements: [{
        group: 0,
        binding: 0,
        type: 'storage',
        hasDynamicOffset: false,
        layout: pointCodec.artifact,
    }],
})
```

Generated accessors and user WGSL compose into one native ShaderModule when
they must share declarations. Separate Scratch ShaderModules remain separate
native modules and can be reused across stages and pipelines. Concrete
resources enter through BindSet; execution enters through Command.

## Program, Pipeline, BindSet, Command

Keep these responsibilities separate:

```text
ShaderModule = source parts + compilation acknowledgement + native module
Program  = immutable stage references + requirements
Pipeline = Program + WebGPU pipeline static state
BindSet  = concrete resources bound to an explicit BindLayout
Command  = one executable GPU action using Pipeline + BindSet + counts/policy
```

Bad kernel model:

```text
Material = Program + data values + render semantics + object assignment
```

Preferred scratch model:

```text
Program declares what code needs.
BindSet supplies which resources are bound.
Command declares when and how execution happens.
Submission records the explicit order.
```

A future `geo` layer may introduce layer styles, symbolizers, renderable layers, or material-like scene concepts if they are useful. Those concepts must lower into scratch primitives; they must not become scratch primitives.

## Program Snapshots And Compilation Provenance

`Program` remains the caller-owned shader contract. Before the native pipeline Promise is issued, pipeline creation snapshots
its module strings, entry points, required layouts, and identity before native
work starts; mutation after that boundary cannot alter the in-flight
transaction. The snapshot is combined with one explicit separator contract and
uses JavaScript UTF-16 code-unit offsets so native compilation locations can be
mapped back to a Program module when the location is actually known.

The successful Pipeline retains the exact immutable required-layout snapshot used by
its creation transaction. Draw and dispatch command preflight consume that Pipeline
snapshot, never the later live `Program.layoutRequirements` property. Caller-owned
Program mutation may affect a future Pipeline, but it cannot rewrite an existing
Pipeline's shader/binding contract.

The resulting pipeline compilation report retains combined and per-module
hashes, module spans, counts, and bounded native messages. It does not retain
complete WGSL or source excerpts in default history, incidents, exported
evidence, or deep descriptor capture. Because implementation-defined native
prose can quote WGSL, exact Program identifiers/numeric literals of at least
three UTF-16 code units and exact contiguous Program spans of at least eight
UTF-16 code units are replaced before retention. Token recognition follows the
WGSL Unicode-XID identifier and complete decimal/hexadecimal numeric-literal
grammar, including leading-dot floats; each message reports
`sourceExcerptRedacted`. A lazy Bloom workspace capped at 32 KiB makes this
check independent of Program source size; collisions may over-redact but cannot
leak an inserted token or span. Native prose is never parsed into a stable code.
The same rule sanitizes retained pipeline/scope/lifecycle native-error strings;
an original native object can remain only as a transient error cause. Unknown
or separator locations remain unmapped. This evidence does not move source
ownership from Program to Pipeline, and Program does not gain concrete resources
or submission state.

## Authoring And Runtime Boundary

Codec and shader composition can happen before runtime, but scratch still needs one coherent contract:

- Build-time path: generate `LayoutArtifact`, WGSL accessor modules, and optional CPU writer code ahead of the app.
- Runtime-initialization path: generate the same artifacts lazily, cache them by canonical ABI/schema signatures, and expose both bounded hashes and structural diagnostics.
- Submission path: consume already-built artifacts only.

This avoids both bad extremes:

- no runtime-only magic codegen hidden inside `submit()`
- no disconnected external codegen whose output the runtime cannot validate

The runtime should be able to inspect artifact metadata and confirm that:

- the `BufferRegion` bound to a Program requirement carries the layout artifact expected by the accessor module
- bind layouts match shader declarations, with reflection as a warn-level guard
- CPU writers produced byte lengths and ranges that match the target `BufferRegion` and its layout witness
- readback views interpret the layout witness captured from the source `BufferRegion`

Diagnostic payloads for these checks should use structured subjects such as `LayoutArtifact`, `LayoutField`, `Program`, `ShaderBinding`, and `BindLayoutEntry`, so tooling can repair the local artifact or declaration without parsing prose.

## WGSL Language Contracts And Immediate Layouts

`Program.requiredLanguageFeatures` is an explicit iterable of WGSL language-extension
names, separate from device `requiredFeatures`. Program creation and every future
pipeline transaction validate the requirement against the Runtime snapshot. Scratch
also derives requirements from attached layout and buffer-view contracts:
`shader-f16` is a device feature, while `buffer_view`,
`unrestricted_pointer_parameters`, `uniform_buffer_standard_layout`, and
`immediate_address_space` are WGSL language features as applicable.

`LayoutCodecUsage` includes `'immediate'`.
`LayoutArtifact.usageCompatibility.immediate` is compatible only for a
constructible fixed-footprint store type that contains no array, atomic, or
opaque buffer. Explicitly requesting an incompatible immediate usage fails
with a structured LayoutCodec diagnostic. Only a compatible
`LayoutUploadView` can be command immediate data. Its explicit `byteOffset` and
`byteLength` select bytes from `bytes.buffer`, consistent with the existing
upload path; they are not constrained to the `bytes` view's visible subrange.

`LayoutBufferViewContract` makes buffer-view built-ins equally explicit. It
records address space/access, source and target layouts, fixed or runtime
buffer size, byte range, required alignment, and whether the pointer comes
from the originating variable or a declared function-parameter chain. Fixed
parameter paths may narrow but not widen; runtime-to-fixed paths fail closed.
Program minimum binding size and command range validation consume these facts
instead of reconstructing them from shader prose.

Generated accessors continue to emit structs, constants, and field readers only. They
never inject `requires`/`enable` directives or resource declarations. Scratch
does not parse or rewrite arbitrary caller WGSL, override expressions, or
dynamic values; caller-authored source remains authoritative. Raw ArrayBuffer
and ArrayBufferView sources remain available for legal WGSL domains outside
the managed host-layout vocabulary.

## Industrial Lesson To Keep, Not Copy

Mature engines often provide materials, shader graphs, node materials, custom shader chunks, plugins, and compute shader helpers. The useful lesson for scratch is not the material layer itself. The useful lesson is:

- make shader code composable
- generate safe accessors for common layout mistakes
- provide diagnostics around bind/layout/shader mismatches
- keep custom WGSL escape hatches
- treat compute as equal to graphics

Scratch should adopt those mechanics without adopting a scene-engine `Material` concept.

## Non-Goals

- Do not add `Material`, `material`, `NodeMaterial`, or material-like aliases to the scratch core API.
- Do not use `Style` or layer styling as scratch terms; style belongs to `geo` or applications.
- Do not let `Program` own concrete resources or per-object values.
- Do not let `BindSet` own shader source or execution counts.
- Do not let `Pipeline` own concrete resource allocation versions.
- Do not generate shader or layout code in the submission hot path.
- Do not make raw packed buffers the default path when a layout-derived writer/accessor can remove manual padding mistakes.
