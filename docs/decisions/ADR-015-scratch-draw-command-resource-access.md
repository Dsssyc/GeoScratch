# ADR-015: Require DrawCommand Resource Access Declarations

## Status

Accepted

## Date

2026-07-09

## Context

ADR-013 added `SubmittedWork.resourceAccesses` and `SubmittedWork.producerEpochs`.
ADR-014 made `ReadbackOperation` use submitted producer epochs to avoid silently reading a newer source epoch.

`DispatchCommand`, upload, copy, resolve, and render attachment writes already contribute explicit access facts to submitted work. `DrawCommand` was the remaining executable command family without an explicit `resources` contract, so render submissions could not report draw-time resource reads and writes. That gap would make later submission dependency validation incomplete.

The Scratch API vision requires commands to declare resources read and written, while render pass attachments remain pass-level writes. The core surface should not infer authoritative resource access from visual-scene bundles, shader reflection, or bind-set heuristics.

## Decision

`DrawCommandDescriptor` now requires explicit resource access declarations:

- `resources.read: Resource[]`
- `resources.write: Resource[]`

`DrawCommand` stores the normalized declarations as `draw.resources`.

Missing, malformed, wrong-runtime, or disposed draw resource declarations fail with structured Scratch diagnostics. Missing or malformed declarations use:

- code: `SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE`
- phase: `command`
- subject: `Command` with `commandKind: 'draw'`

Render submissions record draw declared accesses in `SubmittedWork.resourceAccesses` with the draw command id and pass id. Draw declared writes advance the written resource `contentEpoch`. Draw declared reads do not advance content epochs.

Render pass attachments remain pass-level writes owned by `RenderPassSpec` and submission pass handling. They are recorded separately from draw command accesses and continue to advance attachment texture content epochs once per written attachment resource per pass.

## Alternatives Considered

### Infer draw resources from BindSet

Rejected. Bind sets expose concrete bindings, but they are not the authoritative command access contract. A bind set may contain resources that are not actually used by a particular shader entry point, and future commands may need access declarations outside bind groups.

### Infer draw resources from shader inspection

Rejected. Shader inspection is a guard and helper, not the runtime source of truth. Making reflection authoritative would tie the core hot path to parser completeness and would violate the explicit API model.

### Keep DrawCommand resources optional

Rejected. During 0.x, Scratch is making a clean-cut API transition toward explicit command access facts. Silently treating omitted draw resources as empty would preserve an incomplete contract and make later dependency validation unsound.

### Implement full dependency validation now

Rejected for this slice. Dependency validation needs complete access facts first. This decision makes draw access facts available without adding automatic scheduling, readiness policy behavior, or read-before-write rejection.

## Consequences

- All `DrawCommand` call sites must pass `resources`.
- `SubmittedWork.resourceAccesses` now covers draw declared accesses as well as pass attachment writes.
- Producer epochs can include draw declared writes.
- Render attachment writes remain pass-level facts and are not folded into draw resources.
- Full submission dependency validation, resource readiness policy behavior, `ReadbackCommand`, and automatic scheduling remain future work.
