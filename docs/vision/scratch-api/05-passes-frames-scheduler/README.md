# Passes, Frames, And Scheduler

Status: Vision draft
Date: 2026-06-20

## Decision

Use persistent `PassSpec` objects for stable pass shape. Use `Frame` to bind pass specs to the current frame's command lists.

The first scheduler model is explicit frame order plus dependency validation. Automatic sorting or render-graph scheduling can be built later as an upper orchestration mode.

## PassSpec

`PassSpec` describes stable encoder boundaries and attachment shape.

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
})
```

Compute pass spec example:

```ts
const simulationPass = scratch.pass.compute({
    label: 'simulation',
})
```

Pass specs do not store commands. This prevents stale command lists from surviving across frames.

## Frame

`Frame` is the current frame builder and submission unit:

```ts
scratch.frame({ validation: 'throw' })
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
```

Frame responsibilities:

- collect pass-command pairs in user order
- validate runtime ownership
- validate pass and command compatibility
- validate resource read/write order
- prepare dirty resources
- resolve command readiness policies
- skip empty passes
- record GPU commands
- submit command buffers

## Dependency Validation

The core scheduler does not automatically sort commands. It validates explicit order.

Examples of checks:

- resource from wrong runtime
- disposed or lost resource used by a command
- command reads a resource before the frame prepares or writes it
- same pass reads and writes the same resource without an explicitly allowed pattern
- surface current texture view used outside its frame
- render command inserted into compute pass
- dispatch command inserted into render pass
- dispatch workgroup count exceeds `maxComputeWorkgroupsPerDimension`
- bound storage buffer range exceeds device storage-binding limits

Validation modes:

```ts
type FrameValidationMode = 'off' | 'warn' | 'throw'
```

Development should prefer `throw`. Production or profiling runs may choose `warn` or `off`.

## Readiness Policy Interaction

Dependency validation and resource readiness policy are separate.

- Validation checks whether the frame order and ownership are coherent.
- `whenMissing` checks what to do if a required resource is not ready.

Commands still need explicit readiness policy even when validation is enabled.

## Future Upper Orchestration

Automatic sorting should not be part of the first core scheduler. A future upper layer may provide:

```ts
scratch.schedule(commands, {
    strategy: 'topological',
}).into(frame)
```

That layer can build on command read/write declarations without changing the core frame model.

## Non-Goals

- Do not make pass specs mutable containers for current-frame commands.
- Do not make automatic render graph sorting the default core behavior.
- Do not hide frame order from users who need WebGPU-level control.
- Do not encode geospatial layer order in the scratch scheduler.
