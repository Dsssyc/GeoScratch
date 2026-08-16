# ADR-078: Fill the GPU Render-Patch Budget by Complete Error Cohorts

## Status

Accepted. Supersedes ADR-066's global budget hysteresis and its use of one uniformly
biased trial cut as the final pre-balance topology. The 17 measured trials remain as
bounded base-cut candidates. ADR-068's level-difference-one balance contract,
ADR-076's immutable render roots and local projected-cell evaluation, and ADR-077's
rotation-invariant determinant metric remain in force.

## Date

2026-08-16

## Context

The normalized frame budget is continuous, but ADR-066 could select only one of 17
uniform bias steps. A small camera change could make the current trial exceed the
budget by one patch. Selection then moved every visible branch to a coarser threshold,
even when the next trial used far less than the available budget. In the reproduced
pitch sequence, the base cut changed from 29 patches at a budget of 29 to 24 patches at
a budget of 30, then to 16 patches at a budget of 31. A foreground branch visibly
subdivided and then merged while the GPU left enough budget unused to preserve local
detail.

Global hysteresis concealed some transitions but made the same settled camera depend
on the previously selected bias. Previous-frame topology or bias is not a geometric
fact and cannot be a second selection authority.

## Decision

### Treat a uniform trial as a safe base cut

The GPU still counts 17 complete, prefix-free trial cuts. It selects the finest trial
whose count fits the current frame budget. If no trial fits, it selects the measured
minimum-count trial and reports `budgetLimitedByMinimumTrial` exactly as before.

Selection is stateless. The previous frame's bias and topology are not read, retained,
or compared. Equal current camera, viewport, render roots, and policy facts therefore
produce the same base cut regardless of the approach path.

### Spend residual budget on complete highest-error cohorts

After emitting the base cut, one GPU compute invocation repeatedly examines its
terminal patches. A patch is eligible when it is below the render maximum level and
its current projected-cell span exceeds `maximumCellSpanPixels`. The pass finds the
greatest Q8-quantized span and treats every eligible patch with that span as one
indivisible error cohort.

Every selected parent is replaced only by its frustum-visible children. The complete
cohort executes only when the resulting increase in terminal patch count fits the
remaining frame budget. Equal-error patches are never selected by logical identity,
buffer order, or screen direction. The pass repeats until no complete highest-error
cohort fits, then rebuilds the primary lookup from the completed cut. No CPU traversal,
count readback, or next-frame control loop participates.

The frame budget is a limit, not a target count. It may remain partly unused when every
terminal patch already meets the quality threshold or the remaining slots cannot hold
the next complete visible split. Descriptor truncation remains forbidden.

### Balance only after quality allocation

The persistent compute order is:

```text
reset -> count 17 trials -> select base -> emit base -> error-cohort fill
      -> 2:1 balance -> validate -> finalize indirect draw
```

ADR-068 balancing may add correctness-owned patches after the visual budget is filled.
That overhead remains explicit and is never confused with quality allocation.

### Expose bounded selection facts

Feedback adds:

- `basePatchCount`: the selected uniform trial count;
- `budgetFillSplitCount`: complete error-cohort splits executed before balancing;
- `budgetLimitedRefinementCount`: remaining above-threshold terminal patches whose
  complete visible split does not fit the residual budget.

`unbalancedPatchCount` is the post-fill, pre-balance count. The decoder verifies that
it is never smaller than `basePatchCount`, remains inside the frame budget whenever a
trial fits, and still reconciles exactly with balance overhead and the final count.

The obsolete `budgetHysteresisRatio` descriptor and fact are removed during `0.x.x`;
retaining a no-op compatibility option would falsely imply temporal selection authority.

## Consequences

- A discrete global bias change no longer forces all branches to lose detail together.
- Current local projected error, not previous-frame state, determines which branches
  receive residual budget.
- The selected topology is deterministic and direction-neutral for current inputs:
  quantized ties form an all-or-none cohort rather than using geographic identity as a
  hidden north-west-to-south-east priority.
- The pass is GPU-resident and bounded by the declared render-patch capacity. The first
  implementation uses one compute invocation because the active pre-balance cut is
  small and mutation is strictly ordered; this is an execution detail exposed through
  `budgetFillWorkgroupSize`, not a CPU authority.
- The primary lookup is populated only after error-cohort filling, so rendering and 2:1
  balancing observe one complete topology.

## Verification

The Chrome/WebGPU wireframe proof covers identical-camera approach paths, settled
top-down zoom from 12 through 14, oblique motion, near-plane motion, pitch samples 55,
58, and 61 degrees, and per-frame camera tracking. The two opposite approach paths to
the canonical top-down camera produce identical topology and canvas hashes. Their
maximum-to-minimum quadrant wireframe-density ratio is 1.0903 under a 1.25 gate. The
90-frame tracking proof reports zero submission-frame lag. Descriptor and lookup
overflow, uncaptured errors, device loss, and level-difference violations remain zero.

## Rejected Alternatives

### Increase the number of global bias trials

Rejected because it reduces but cannot remove discrete whole-view cliffs. It also
spends more traversal work without allocating budget according to local error.

### Keep global hysteresis

Rejected because equal current inputs could retain different biases. Temporal history
is not allowed to select a permanent geometry topology.

### Break equal-error ties by logical identity or buffer order

Rejected because neither geographic identity nor parallel base emission order is a
quality fact. Geographic keys impose a stable screen-direction bias in top-down views;
buffer order makes topology depend on GPU scheduling. Equal current error therefore
has equal allocation authority.

### Truncate children when a split does not fit

Rejected because a partial split breaks prefix-free completeness and can create terrain
holes. Residual budget may stay unused, but a selected patch is never partially replaced.
