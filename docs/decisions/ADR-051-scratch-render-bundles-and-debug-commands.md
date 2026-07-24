# ADR-051: Add Scratch Render Bundles And Debug Commands

## Status

Accepted

## Date

2026-07-24

## Context

Scratch could submit ordinary render and compute commands but had no managed
equivalent for native `GPURenderBundleEncoder`, `GPURenderBundle`,
`executeBundles()`, or the debug command mixin. Raw device access was therefore
the only path for valid static render-command reuse and encoder-native debug
groups.

Render bundles are not generic command buffers. They have a fixed render-pass
layout, admit a restricted command set, and clear render-pass state after
execution, including `executeBundles([])`. A persistent native bundle also
captures physical pipeline, binding, buffer, immediate-data, and texture-view
facts. It cannot truthfully outlive an allocation replacement, BindSet
re-preparation, current Surface texture, or external frame.

## Decision

### Restricted Bundle Command Model

`BundleDrawCommand` is the only draw command accepted by a `RenderBundle`.
It captures the same pipeline, BindSet invocations, vertex/index buffers,
immediate data, draw count, and declared resource access as an ordinary Draw,
but its contract is deliberately narrower:

- `whenMissing` is always `throw`;
- fallback commands are forbidden;
- viewport, scissor, blend constant, and stencil reference are forbidden;
- query brackets and attachment operations are forbidden; and
- only `BundleDrawCommand` and `DebugCommand` may appear in the bundle command
  sequence.

The restricted command is separately branded and cannot be forged from an
ordinary Draw or a prototype-shaped record.

### Explicit Layout And Realization

Every `RenderBundleDescriptor` explicitly declares:

```ts
type RenderBundleDescriptor = Readonly<{
    label?: string
    realization: 'persistent' | 'attempt-local'
    colorFormats: Iterable<GPUTextureFormat | null>
    depthStencilFormat?: GPUTextureFormat
    sampleCount?: 1 | 4
    depthReadOnly?: boolean
    stencilReadOnly?: boolean
    commands: Iterable<BundleDrawCommand | DebugCommand>
}>
```

At least one non-null color format or a depth/stencil format is required.
Descriptor getters and iterables are snapshotted exactly once before native
effects. Color slots preserve explicit `null` indices; compatibility ignores
only trailing null slots, matching the native render-pass layout rule.

The realization choice is required rather than defaulted:

- `persistent` creates and acknowledges one native bundle in the Promise-only
  factory;
- `attempt-local` keeps only the immutable authored bundle and realizes one
  native bundle inside each selected submission attempt.

Scratch never silently replaces native bundle execution with ordinary Draw
replay.

### Persistent Realization

Persistent creation snapshots:

- every referenced BufferResource or TextureResource allocation version;
- every BindSet preparation generation and prepared snapshot hash; and
- complete per-command immediate bytes.

Native encoder creation and `finish()` belong to one
`render-bundle-creation` GPU operation. Validation, internal, OOM, device-loss,
runtime-disposal, and synchronous-exception outcomes are attributed to that
operation without claiming synchronous certainty before scopes settle.

A persistent bundle becomes `stale` when any captured allocation or BindSet
preparation changes. Submission rejects it before command-encoder effects.
There is no hidden rebuild or implicit `prepare()`. Attempt-local external
texture or Surface dependencies are rejected from persistent realization.

### Attempt-Local Realization

An attempt-local bundle may reference the narrow temporal texture authority
defined by ADR-049. Submission resolves readiness and validates all selected
dependencies first, snapshots immediate data once, then realizes each selected
bundle at most once for that attempt. Repeated occurrences of the same bundle
execute the same attempt-local native object.

No caller getter, iterator, or callback runs after native effects begin.
Attempt-local native handles are held only by the submission authority and do
not become Resources, allocation versions, content epochs, or persistent
diagnostic facts.

### Pipeline And Pass Compatibility

Bundle creation validates each pipeline against the declared bundle layout:

- color formats, after trailing-null normalization;
- depth/stencil format;
- sample count;
- depth read-only constraints; and
- stencil read-only constraints.

The stencil-write check follows the native `writesStencil` rule: a nonzero
write mask and a non-`keep` operation count only for faces not removed by the
pipeline's cull mode.

Execution validates the bundle layout against the selected RenderPassSpec.
A pass that is read-only requires the corresponding bundle declaration to be
read-only. Fragmentless depth-only bundles are valid when their layout and pass
match.

`ExecuteRenderBundlesCommand` always calls native `executeBundles()`, including
for an empty sequence. Because native execution clears the current pipeline,
bind groups, vertex buffers, and index buffer, every following Scratch Draw
remains self-contained and re-emits all required state.

### Resource Effects And Submitted Facts

Native bundle encoding itself does not advance content epochs. After a
successful `executeBundles()` call, each nested BundleDraw's declared writes
advance once per executed bundle occurrence. `SubmittedWork.resourceAccesses`
records each occurrence with its own before/after epoch, and
`SubmittedWork.renderBundles` retains bounded bundle ID, realization,
execute-command ID, and immutable command IDs. A synchronous execution failure
publishes no nested write effect.

### Debug Commands

One `DebugCommand` family represents:

- `push-group` with a label;
- `pop-group`; and
- `insert-marker` with a label.

It lowers to the native debug mixin on command, render-pass, compute-pass, and
render-bundle encoders. Debug commands carry stable command identity but no
resource, scheduling, readiness, or epoch semantics.

Groups must balance inside the exact native encoder scope. Render, compute, and
bundle command arrays are validated independently. Command-encoder groups may
span passes in one encoder segment but may not cross a queue-side upload
boundary, because that boundary finishes the current command encoder.
Unbalanced diagnostics retain the total open count, at most 16 command IDs,
and an omitted count. Labels are bounded in diagnostic subjects and never
become a retained event log.

Synchronous native debug exceptions become
`SCRATCH_DEBUG_COMMAND_NATIVE_FAILED`. Delayed validation, internal, OOM, and
device outcomes remain owned by the enclosing submission or persistent bundle
creation operation.

### Ownership And Lifecycle

`RenderBundle`, `BundleDrawCommand`, `ExecuteRenderBundlesCommand`, and
`DebugCommand` use exact prototypes plus module-private state. Their
constructors are closed; Runtime factories are the only creation path.
Wrong-Runtime, forged, disposed, stale, incompatible, and unsupported values
fail with structured diagnostics before native effects where deterministically
knowable. Runtime disposal disposes every owned RenderBundle.

## Consequences

Scratch now expresses native render-bundle encoding and execution without CPU
replay, hidden preparation, or a global frame state machine. Static workloads
can retain an acknowledged native bundle, while temporal workloads use the
same explicit attempt authority as their Surface or external-texture inputs.

The public model remains macro-oriented: bundles compose stable pipelines,
bindings, buffer ranges, command data, and declared effects without introducing
a scene graph, material abstraction, or general render graph.

## Rejected Directions

- Replaying ordinary Draw commands instead of native bundles.
- Defaulting an omitted realization mode.
- Silent fallback re-encoding after a persistent bundle becomes stale.
- Capturing a Surface current texture or external frame as permanent state.
- Allowing pass-only render state or query brackets inside bundles.
- Ignoring `executeBundles()` state clearing, especially for an empty sequence.
- Advancing resource epochs while encoding rather than executing a bundle.
- Treating debug markers as console logs or retaining an unbounded debug stack.

## Acceptance Evidence

`tests/scratch-render-bundle-debug.test.js` covers persistent and attempt-local
realization, temporal dependencies, allocation and BindSet staleness,
immediate snapshots, fragmentless depth-only use, pass compatibility, exact
stencil culling, empty execution state clearing, repeated-occurrence epochs,
closed ownership, lifecycle races, bounded evidence, native failure
attribution, one-shot descriptor normalization, balanced scopes, and bounded
reuse stress.

Public type tests cover both package entrypoints, required realization,
restricted BundleDraw descriptors, closed constructors, immutable facts,
submission command unions, diagnostics queries, and SubmittedWork bundle
facts. The native source inventory records bundle creation, finish, execution,
and all three debug methods. Headed public-package proof remains part of the
consolidated Phase 6 browser gate.
