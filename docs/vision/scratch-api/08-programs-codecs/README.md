# Programs, Layout Codecs, And Shader Composition

Status: Vision draft
Date: 2026-07-06

## Decision

Shader-facing APIs should be split into explicit artifacts:

- `LayoutSpec` describes logical data shape.
- `LayoutArtifact` records computed offsets, stride, padding, alignment mode, usage lowering, and a stable structural hash.
- `LayoutCodec` is the preparation artifact built from a layout: CPU writers, readback views, and WGSL accessor modules.
- `Program` describes shader source, generated modules, entry points, required bind layouts, required features, and diagnostic metadata.
- `Pipeline` is stable WebGPU executable state for one `Program` entry point plus render or compute pipeline state.
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

user WGSL + generated accessor modules + bind-layout contract
    -> Program
    -> Pipeline
    -> Command
    -> Submission
```

This keeps code generation and runtime execution connected without hiding behavior:

- Layout and shader helpers may be generated ahead of runtime, at build time, or lazily during runtime initialization.
- Submission-time execution consumes explicit artifacts. It must not depend on ad-hoc string generation or hidden shader mutation.
- Generated artifacts must be inspectable, cacheable by structural hash, and diagnosable through the shared `ScratchDiagnostic` envelope in `09-diagnostics-validation`.

## LayoutCodec

`LayoutCodec` is not a resource and not a scheduler feature. It is a bridge between a typed layout and the byte-level facts needed by CPU, WGSL, and readback.

Target outputs:

- `LayoutArtifact`: segment offsets, element stride, field offsets, padding, alignment mode, total byte length, storage/vertex/readback compatibility, and structural hash
- CPU writer: packs logical values into GPU-aligned bytes while skipping padding
- upload view: the contiguous byte range that can be sent with one upload command
- readback view factory: creates typed, `DataView`, strided, or explicitly deinterleaved views from returned bytes
- WGSL accessor module: generated structs/functions/constants for safe shader-side field access
- diagnostics: unsupported field format, incompatible usage, non-representable alignment, byte-length mismatch, or unsafe strided view requests, reported through `ScratchDiagnostic`

The high-performance CPU path is:

```text
source AoS/SoA data
    -> CPU writer fills one GPU-aligned ArrayBuffer or leased staging span
    -> one explicit UploadCommand writes the contiguous range
```

This avoids one CPU-to-GPU operation per structure and also avoids a GPU-side repack pass that can double peak VRAM. If an external schema is already GPU-aligned, the writer can use a direct view or a bulk copy; otherwise it writes fields into the aligned layout and skips padding on CPU.

Raw packed bytes remain an escape hatch, but they are not the default authoring model. Forcing authors to manually mirror WGSL padding in shader code is a correctness hazard, especially when code is AI-assisted.

## Program

`Program` is a shader contract. It owns code and code-adjacent metadata, but it does not own concrete resources or scene meaning.

It should declare:

- label
- source modules: user WGSL plus generated WGSL accessor modules
- entry points and stages
- required `BindLayout` objects
- required layout codecs or accessor modules
- override constants or specialization keys
- required features and limits
- shader inspection and cross-check diagnostics

Example shape:

```ts
const pointCodec = scratch.layoutCodec(pointLayout, {
    usage: ['storage', 'readback'],
})

const points = await scratch.buffer({
    label: 'points',
    usage: ['storage', 'copyDst', 'copySrc'],
    layout: pointCodec.artifact,
})

const simulateProgram = scratch.program({
    label: 'simulate points',
    modules: [
        pointCodec.wgslAccessors({ namespace: 'Point' }),
        scratch.wgsl`
            @group(0) @binding(0)
            var<storage, read_write> points: array<PointStorage>;

            @compute @workgroup_size(64)
            fn main(@builtin(global_invocation_id) id: vec3u) {
                let i = id.x;
                let p = Point_readPosition(points, i);
                Point_writePosition(points, i, p);
            }
        `,
    ],
    entryPoints: { compute: 'main' },
    bindLayouts: [simulationLayout],
})
```

The exact call shapes may evolve. The invariant is stable: generated accessors and user WGSL compose into a `Program`; concrete resources enter through `BindSet`; execution enters through `Command`.

## Program, Pipeline, BindSet, Command

Keep these responsibilities separate:

```text
Program  = shader code contract + generated modules + entry points
Pipeline = Program entry point + WebGPU pipeline static state
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
- Runtime-initialization path: generate the same artifacts lazily, cache them by structural hash, and expose diagnostics.
- Submission path: consume already-built artifacts only.

This avoids both bad extremes:

- no runtime-only magic codegen hidden inside `submit()`
- no disconnected external codegen whose output the runtime cannot validate

The runtime should be able to inspect artifact metadata and confirm that:

- buffer resources use the layout artifact expected by the program accessor module
- bind layouts match shader declarations, with reflection as a warn-level guard
- CPU writers produced byte lengths and ranges that match the target resource layout
- readback views interpret the same layout version that produced the data

Diagnostic payloads for these checks should use structured subjects such as `LayoutArtifact`, `LayoutField`, `Program`, `ShaderBinding`, and `BindLayoutEntry`, so tooling can repair the local artifact or declaration without parsing prose.

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
