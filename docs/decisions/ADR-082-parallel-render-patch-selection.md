# ADR-082: Parallelize and Bound High-Pitch Render-Patch Selection

## Status

Superseded by [ADR-083](ADR-083-webmercator-inverse-cover-passive-virtual-raster.md).
The measured high-pitch benchmark and bounded frame-authority gates remain required,
but parallel root/trial traversal is no longer current architecture.

## Date

2026-08-18

## Context

The original camera benchmark covered only `pitch=0`. A user-observed high-pitch drag delay led
to a matched 90-frame benchmark at `pitch=70`, `bearing=90`. With bounded double-flight, top-down
wireframe admitted 72 of 90 camera transitions, but pitched shaded and wireframe admitted only 36
and 37. Their frame-interval P95 reached approximately 25 ms and lag reached three frames.

Stage instrumentation showed application construction and `queue.submit` at only 2–3 ms. Native
observation took roughly 47–50 ms at high pitch versus 13–18 ms top-down. Shaded and wireframe
were similarly slow, excluding fragment presentation as the primary cause.

The persistent render-patch graph allocated 12,544 patch slots and a 32,768-entry lookup because
capacity was `maximumActiveTiles * 256`. The actual high-pitch frame budget was 34 and the balanced
cut contained 37 patches. Every balance pass cleared the full lookup, and the count kernel used one
invocation per root that traversed the complete quadtree serially for all 17 bias trials.

## Decision

### Parallelize complete trial counting

`countRenderPatchTrials` maps each `(render root, bias trial)` to an independent invocation. Trial
counts remain atomic across roots, all 17 complete cuts are still measured, and selection remains
stateless. For one root, 17 lanes in one workgroup replace 17 serial traversals in one lane.

### Derive persistent capacity from screen policy

At creation, the terrain renderer computes baseline viewport rows and columns from the existing nominal patch
span (`cellsPerPatchEdge * maximumCellSpanPixels`). It applies the configured maximum pitch count
ratio, multiplies by four for balance headroom, rounds up to a power of two, and clamps to the
theoretical data-frontier maximum. A 320×180 test surface allocates 64 patches; a 1280×800 surface
allocates 256 and a larger DPR/4K surface scales to 512 or 1024.

### Exit balancing only after stable primary ownership

The balance kernel retains its 14-pass maximum. A workgroup atomic counts splits in each pass.
After an odd pass has copied the cut back from scratch to the primary buffers, the kernel uses
WGSL `workgroupUniformLoad` to obtain one uniform split count. If that pass produced no split, all
lanes exit the loop together. This preserves the primary-buffer postcondition and WGSL uniform
barrier rules. The synchronization behavior follows the normative
[WGSL `workgroupUniformLoad` contract](https://gpuweb.github.io/gpuweb/wgsl/#workgroupUniformLoad-builtin).

## Evidence

On Chrome 151 with a 120 Hz 1280×800 proof viewport:

| Path | Transitions | Coverage | Frame P95 | Lag max | Observation P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pitched shaded before | 36/90 | 40% | ~25.2 ms | 3 | ~49.7 ms |
| Pitched shaded after | 71/90 | 79% | 9.9 ms | 1 | 17.8 ms |
| Pitched wireframe before | 37/90 | 41% | ~25.5 ms | 3 | ~46.7 ms |
| Pitched wireframe after | 77/90 | 86% | 9.8 ms | 1 | 17.4 ms |
| Top-down after | 90/90 | 100% | 10.0 ms | 0 | 9.2 ms |

Both pitched paths retain zero stale transitions. The complete 12-camera proof, A-to-B-to-A
identity, zoom monotonicity, 2:1 balance, overflow checks, failure injection, and cleanup all pass.

## Consequences

- High-pitch tracking no longer collapses to approximately half-rate on the acceptance machine.
- Capacity follows screen quality policy instead of unrelated data residency capacity.
- The algorithm still computes all trial cuts, applies complete error cohorts, and validates the
  final balanced cut; this is an execution optimization, not a LoD policy change.
- Benchmark instrumentation records display intervals, camera transitions, synchronous
  construction, native observation, queue occupancy, and render-patch facts.

## Rejected Alternatives

### Increase in-flight submissions again

Rejected because triple-flight previously added only two transitions while increasing obsolete
issued work. The measured bottleneck was GPU execution, not insufficient queue depth.

### Reduce the pitch patch-count ratio

Rejected because reducing the final budget from 34 to 23 did not improve transition coverage or
native observation and would lower visible quality.

### Remove terrain drawing or 2:1 balancing

Rejected as production changes. Diagnostic A/B showed terrain draw contributed several
milliseconds, but compute remained the larger cost; removing balance violates the crack-free cut
contract. The accepted optimizations preserve both stages.
