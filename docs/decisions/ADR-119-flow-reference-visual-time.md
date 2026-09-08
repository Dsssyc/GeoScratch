# ADR-119: Normalize Flow Visual Motion To A 60 Hz Reference

## Status

Accepted. Replaces Flow Field's one-visual-step-per-submission timing while retaining
the 60 Hz displacement, retirement and byte-history formulas. Default A, existing
B/C/D shape rules, the source-center cache from ADR-118, backend data, public
Scratch/Geo contracts, and the frozen Flow Layer example remain unchanged.

## Date

2026-09-08

## Context

Matching the reference's displacement multiplier of 50, particle count, drop rate,
alpha and trail decay is insufficient when the actual update frequency differs.
One displacement and one decay per submission make slower rendering slow the flow,
particle replacement and trail disappearance together. Model-time Rate is a
different authority: it selects interpolated simulation data, not visual advection
time or wall-clock compensation.

The existing history decay includes byte quantization. Replacing repeated
`floor(255*color*.996)/255` with `pow(.996, elapsedSteps)` does not preserve it.
For example byte 254 becomes 252 then 250 after two original operations, but a
single squared-factor operation yields 251. Fractional decay written back to
rgba8 can also repeatedly round to the same byte.

## One Visual Clock

The application reads one monotonic wall time for an admitted frame and passes it
to the renderer. One example-local clock produces `referenceSteps`, `wholeSteps`
and `discardedSeconds`; particles and history consume that same result. They do
not read their own clocks. The renderer advances visual time only when particles
are eligible and timeline playback is enabled. Model-time Rate and its sign keep
their existing data-selection meaning, with no additional user-facing parameter.

For an accepted interval, `s = 60 * min(elapsedSeconds, .05)`. Intervals above
250 ms discard the entire gap and return zero advancement. The first frame,
disabled frames, and the first frame after a reset/resume reanchor at zero. A
shorter stall above 50 ms discards its excess rather than storing debt. Pause,
play, seek/reset, presentation reset and temporal suspension reset the clock phase.
Reset preserves monotonic-time validation while clearing the advancing anchor
and fractional remainder. Invalid/backward times are rejected without consuming
the prior valid anchor.

The clock distributes `wholeSteps = floor(remainder + s)` with a small numerical
boundary tolerance and retains only the sub-tick remainder. Normally this gives
2 at 30 Hz, 1 at 60 Hz, and alternating 0/1 at 120 Hz. Both age and history use
those same whole ticks; no additional per-particle time accumulator is introduced.

## Particle Time

Each positive encoded update scales the existing configured `time_step` by s.
Its predicted substep count is the larger of the configured base count and
`ceil(length(predictedProjectedDisplacement) / requestedSourceCellSize)`, bounded
to 16. `requestedSourceCellSize` is obtained from the public address-space matrix
identity and WebMercator matrix cell size, in projected meters, not zoom index or
ground meters. Current-position latitude scaling is applied before this ratio.
Parent fallback does not enlarge the requested integration cell size.

The first implementation used `ceil(s)`. A runtime counterfactual showed that
this could keep the renderer near 30 Hz by requesting extra U/V samples solely
because of timing jitter or a previous slow frame. The source-scale rule avoids
that feedback without reducing the configured base count or removing any
per-sample checks. It is a start-velocity prediction: subsequent acceleration and
the 16-step ceiling mean it does not guarantee a strict per-substep CFL bound or
continuous collision detection through arbitrarily small dry gaps.

The inherited displacement scale stays 50. Zero/current low-threshold
speed still immediately retires a particle during simulation; missing data still
holds without drawing a false segment.

For per-reference-tick probability p, retirement probability is
`1 - pow(1 - p, s)`. The s=1 branch returns p directly to preserve the original
60 Hz numerical formula. For constant speed, this retains the same survival
probability over equal accepted visual time, within GPU arithmetic accuracy.
It does not require identical random trajectories across different frame counts.

The particle record stays 56 bytes with u32 age/stagnation fields. The existing
config padding at byte offsets 160/164/168 carries fractional s, whole elapsed ticks,
and requested source cell size; the config remains 272 bytes.
Age increments by whole ticks with the existing saturation rule, including unknown
holds. Stagnation compares total displacement against the per-reference threshold
times s and accumulates only whole ticks; real displacement resets it, while
unknown holds do not consume its budget. Global whole-tick phase can differ from
an individual birth/reset by at most one reference tick. The 3600/30 bounds retain
their reference-step meaning rather than growing with a slower submission rate.

`simulatedReferenceSteps` reports the sum in encoded positive calls. It is not an
observation of actual GPU positions, successful GPU integration, or frame rate.

## Reuse Cached Residency Evidence

The source-center cache also reuses its recorded exact-owner residency proof at
the matching publication epochs instead of repeating eight resolution lookups
per display fragment. Public sampler edge-transition checks and unknown-owner /
unknown-halo fallbacks remain. Native cached-versus-direct comparison is unchanged;
this adds no cache state or network dependency.

## Quantized History And Zero-Time Frames

The history uniform gains u32 `decaySteps` at byte offset 344 inside the unchanged
352-byte aligned block. In the existing history pass, execute the original decay
operation zero through three times, then apply its existing RGB residual cutoff.
For zero ticks return the copied/reprojected color without decay or cutoff. There
is no new history texture, pass, format, or persistent fractional-color buffer.
At 60 Hz the one-tick formula remains the original formula; at 120 Hz the texture
is not subjected to a repeatedly rounded fractional decay.

When s=0, do not run particle simulation and do not draw its previous segment into
raw history again. Only reproject or reclip existing history for the current view
and presentation. Otherwise paused control events would either advance particles
or brighten their last segments despite zero elapsed visual time. Camera
reprojection can resample history spatially; zero time does not promise unchanged
texture bytes across a camera transform.

Explicit seek/View/Sample/trails resets retain their existing clear semantics.
**A paused reset can leave the particle view empty until playback resumes.** The
implementation does not quietly warm up a new particle pool or advance a hidden
visual clock to fill it. Pausing alone preserves existing history. Temporal
readiness can settle while paused, but that is not permission to simulate.

## Verification And Limits

Native particle verification passed 54 simulation cases and 12 substep-prediction
probes, including the original 31 reference cases. Controlled 30/60/120 Hz
one-second tests produced equal displacement and
age, equal normalized stagnation duration, unchanged unknown-hold positions, and
immediate zero-speed death even on a half step with zero whole age ticks. The
60 Hz drop helper matched the original probability exactly; fractional-time GPU
probability error was bounded independently from the one-second survival product.
Prediction probes cover source-cell crossings, rotation, the configured minimum,
parent fallback, intermediate dry/unknown samples, and the 16-step cap. Node
checks include noncontiguous matrix identities; virtual-raster level is not zoom.

Native history verification exercised 833 passes and checked all source byte
values against repeated original quantization. Its 30/60/120 Hz accepted-time
sequences matched exactly for existing ink, including zero-tick identity and finite
decay. The pure clock checks cover regular and irregular cadence, invalid inputs,
disabled controls, reset/resume, caps and long-gap debt rejection.

Separate headless Chrome/WebGPU real-dataset tests passed paused C-D-C byte-identical
screenshots, camera/resize and time-pair transitions, bounded cleanup, and zero-time
controls. With native approximately 60 Hz and controlled approximately 30 Hz frame
opportunities, accepted reference ticks per wall second measured 59.914 and 59.924.
Native GPU tests, not a claimed 120 Hz browser display, verify the 120 Hz formulas.

The isolated `flow-field-center-cache-performance.mjs` comparison at zoom 9,
1512x861 reference pixels and DPR 2 measured Flow Layer at 59.997 updates/s,
direct center reconstruction at 31.247, and cached linear reconstruction at
59.987. Resident worker tasks stayed zero; cached page builds remained at one
while alpha advanced. The cache also matched direct coverage exactly in 108,490
native probes. These are bounded test-scene measurements, not a guarantee of
60 Hz across every camera, display size, device, or streaming transition.

Nonuniform fields, resampling, finite substeps, stochastic retirement and different
injection times can still produce different rasterized trails. This normalizes
accepted visual time, not GPU throughput. Capped/discarded intervals intentionally
lose time; the system does not accelerate afterward to repay them.

Reproduction gates:

```sh
npm run typecheck
npm test -- --reporter dot
npm run build
node tests/browser/flow-field-center-cache-performance.mjs
node tests/browser/flow-field-visual-time.mjs
node tests/browser/flow-field-center-cache.mjs
node tests/browser/flow-field-particle-reference.mjs
node tests/browser/flow-field-history-time.mjs
node tests/browser/flow-field-center-ab.mjs
node tests/browser/flow-field-boundary-ab.mjs
node tests/browser/flow-field-history.mjs
node tests/browser/flow-field-history-retained.mjs
node tests/browser/flow-field-reveal-index.mjs
```

Run the performance comparison without concurrent GPU workloads. Complete package
builds before browser tests because rebuilding briefly removes generated package
entrypoints. Full Node verification passed 1,658 tests with two existing pending
cases; type checks and production build passed. The existing shared-runtime chunk
size warning remains.

## Rollback

Commit this timing change separately after source-cache commit `e6abb2f`. Reverting
only the timing commit preserves that cache and restores the preceding cadence.
The pre-cache baseline is `3ecd413`, also retained at
`socu/flow-before-cadence-3ecd413`. To undo both phases, revert timing first, then
`e6abb2f`; preserve any later work instead of resetting the shared working tree.
Do not combine either rollback with backend regeneration or changes to frozen
Flow Layer.
