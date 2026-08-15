# ADR-068: Balance the Final DEM Render-Patch Cut on the GPU

## Status

Accepted. ADR-076 changes the traversal roots and error metric; this ADR's final-cut
balance and validation contract remains current.

## Date

2026-08-09

## Context

`GpuTileFrontier` already guarantees that adjacent resident source tiles differ by
at most one matrix level. The later DEM render-patch stage is a separate geometry
authority: it refines each visible source tile from projected grid spacing. That
independent refinement could place a level `L` patch directly beside a level `L+2`
patch. The terrain shader's bounded edge snapping concealed the crack, but the final
geometry cut was still an unrestricted quadtree and the wireframe exposed a real 4:1
adjacency.

The source-frontier invariant does not automatically transfer through a later
subdivision stage. The final render-patch cut needs its own explicit balance gate.

## Decision

The DEM render-patch frontier produces a restricted quadtree whose edge-adjacent
patches differ by no more than one level.

After projected-grid trial selection and emission, one 256-invocation compute
workgroup performs 14 bounded ping-pong iterations over the emitted patch buffer and
an equally bounded scratch buffer. Each iteration probes the current logical-patch
lookup for exact finer edge neighbors. A patch with a neighbor more than one level
finer is replaced by its four children. Primary and scratch lookup tables are rebuilt
cooperatively between iterations with `storageBarrier()` ordering. Fourteen is the
absolute render-matrix ceiling, so convergence is bounded independently of camera
history; the even iteration count leaves the final cut in the existing primary ABI.

A separate final validation kernel recomputes level and cell-span ranges from the
actual balanced cut and reports its maximum adjacent level delta. Feedback rejects a
delta greater than one, capacity overflow, or a count that does not satisfy:

```text
finalPatchCount = unbalancedPatchCount + 3 * balanceSplitCount
```

The global frame budget continues to select the initial complete projected-grid cut.
Balance splits are correctness overhead and are reported separately; they are not
silently truncated to force the final count back under that visual-density budget.
The hard allocation remains the complete bounded descendant capacity.

Terrain edge snapping remains a defensive shader property for bounded inputs and
transition robustness. It is not the topology authority and does not justify a 4:1
final cut.

## Consequences

- Selection, balancing, validation, and indirect draw remain GPU-only in one ordered
  submission. No CPU traversal or control readback is introduced.
- Each parity owns one additional bounded patch buffer and lookup table.
- Diagnostics expose the initial count, split count, balance overhead, fixed pass
  count, and measured maximum adjacent level delta.
- The final render-patch cut now preserves the same level-difference-one contract
  expected from the source frontier, while data residency and geometry refinement
  remain separate authorities.

## Verification

Chrome 151 on Apple Metal completed the shaded/wireframe and zoom 10, 11, 12, and 14
camera sequence with no console, page, HTTP, WebGPU, overflow, or device-loss error.
At pitched zoom 14, the projected-grid cut contained 25 patches; three balance splits
produced 34 final patches and the validation kernel reported a maximum adjacent level
delta of one. Persistent graph identity stayed unchanged across presentation changes.

## Rejected Alternatives

### Rely on arbitrary-delta mesh stitching

Rejected because visual crack suppression does not make the selected topology
balanced and increases shader coupling to accidental cut shapes.

### Clamp every patch to a camera-wide level

Rejected because it removes the near/far screen-space LoD behavior the render-patch
stage exists to provide.

### Balance on the CPU after readback

Rejected because it adds a delayed second authority, host-authored patch uploads, and
camera-transition latency to an otherwise GPU-driven frame.
