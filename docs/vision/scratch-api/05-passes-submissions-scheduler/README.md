# Passes, Submissions, And Scheduler

Status: Vision draft
Date: 2026-07-06

## Decision

Use persistent `PassSpec` objects for stable pass shape. Use `Submission` as the core GPU-kernel submission model that binds pass specs to the current command lists.

The old `Frame` name is removed from the scratch core model. A frame is an application or presentation cadence; a submission is work sent toward the GPU queue. A submission may present to a surface, or it may be compute-only/offscreen.

The first scheduler model is explicit submission order plus dependency validation. Automatic sorting or render-graph scheduling can be built later as an upper orchestration mode.

## PassSpec

`PassSpec` describes stable encoder boundaries, attachment shape, and pass-level instrumentation such as timestamp writes or occlusion query-set ownership.

Render pass spec example:

```ts
const scenePass = scratch.pass.render({
    label: 'scene',
    color: [
        {
            target: sceneColor,
            load: 'clear',
            store: 'store',
            clear: [0, 0, 0, 1],
        },
    ],
    depth: {
        target: depthTexture,
        load: 'clear',
        store: 'store',
        clear: 1,
    },
    occlusionQuerySet: visibilityQueries,
    timestampWrites: {
        querySet: renderTiming,
        begin: 0,
        end: 1,
    },
})
```

Compute pass spec example:

```ts
const simulationPass = scratch.pass.compute({
    label: 'simulation',
    timestampWrites: {
        querySet: simulationTiming,
        begin: 0,
        end: 1,
    },
})
```

`timestampWrites` lower to WebGPU pass descriptor timestamp writes and require a `timestamp` query set. `occlusionQuerySet` is render-pass-only and requires an `occlusion` query set. Query result transfer is not implicit in pass specs; resolve and readback remain explicit commands or operations.

Pass specs do not store commands. This prevents stale command lists from surviving across submissions.

## Submission

`SubmissionBuilder` records one explicit pass-command sequence. It is not a display frame and does not imply presentation:

```ts
const submitted = scratch.submission({ validation: 'throw' })
    .compute(simulationPass, [
        simulateParticles,
    ])
    .render(scenePass, [
        drawTerrain,
        drawParticles,
    ])
    .render(outputPass, [
        compositeToSurface,
    ])
    .submit()

await submitted.done
```

Conceptual split:

- `SubmissionBuilder` records and validates the current pass-command sequence.
- `SubmittedWork` is returned by `.submit()`. It owns the submitted-work id, `done` promise, producer epochs, diagnostics, and links used by readback operations.

`SubmittedWork` should not be thenable. Waiting uses `await submitted.done`, not `await submitted`. This keeps the submitted-work object inspectable and consistent with `ReadbackOperation`, where the object is not itself a promise.

Submission responsibilities:

- collect pass-command pairs in user order
- validate runtime ownership
- validate pass and command compatibility
- validate resource read/write order
- prepare explicit transfer operations
- resolve command readiness policies
- skip empty passes
- record GPU commands
- submit command buffers
- return `SubmittedWork`

## Presentation Is A Submission Mode

A submission may present, but presentation is not the definition of the core submission unit:

- no surface target -> compute-only or offscreen submission
- surface output -> presentation submission that borrows a surface current texture view

CPU/GPU data motion is explicit. Uploads, copies, render writes, compute writes, and readback staging all participate in the same submission order and epoch validation. Results return to the CPU through a `ReadbackOperation`, for example `await readback.toArray()`, not through `buffer.toArray()`. See `07-transfers-epochs` for the full model.

Application code may still have a `renderFrame()` or animation-frame loop. That application frame can create one or more scratch submissions, but it is not the scratch core type.

## Dependency Validation

The core scheduler does not automatically sort commands. It validates explicit order.

Examples of checks:

- resource from wrong runtime
- disposed or lost resource used by a command
- command reads a content epoch before the submission prepares or writes it
- same pass reads and writes the same resource without an explicitly allowed pattern
- surface current texture view used outside its owning presentation submission
- render command inserted into compute pass
- dispatch command inserted into render pass
- dispatch workgroup count exceeds `maxComputeWorkgroupsPerDimension`
- bound storage buffer range exceeds device storage-binding limits

Validation modes:

```ts
type SubmissionValidationMode = 'off' | 'warn' | 'throw'
```

Development should prefer `throw`. Production or profiling runs may choose `warn` or `off`.

Validation findings should use the shared `ScratchDiagnostic` envelope from `09-diagnostics-validation`. Submission validation should attach a deterministic diagnostic report to `SubmittedWork` when work is submitted, and should throw a structured diagnostic error in `throw` mode rather than a prose-only `Error`.

## Readiness Policy Interaction

Dependency validation and resource readiness policy are separate.

- Validation checks whether the submission order and ownership are coherent.
- `whenMissing` checks what to do if a required resource is not ready.

Commands still need explicit readiness policy even when validation is enabled.

## Future Upper Orchestration

Automatic sorting should not be part of the first core scheduler. A future upper layer may provide:

```ts
scratch.schedule(commands, {
    strategy: 'topological',
}).into(submission)
```

That layer can build on command read/write declarations without changing the core `Submission` model.

## Non-Goals

- Do not make pass specs mutable containers for current-submission commands.
- Do not make automatic render graph sorting the default core behavior.
- Do not hide submission order from users who need WebGPU-level control.
- Do not encode geospatial layer order in the scratch scheduler.
- Do not expose submission validation as prose-only errors.
- Do not use `Frame` as the scratch core submission type; frame cadence belongs to geo, app, or presentation layers.
