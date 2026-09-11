# Flow Field

Run `npm run backend:setup` once, then `npm run dev` from the repository root and
open `/flowField/index.html`. The shared backend serves the existing COG
collection at `/api/flow/` alongside Underwater Terrain; switching examples
requires no restart. Missing collections require explicit preparation as
described in the [backend guide](../backend/README.md#prepare-flow-data).

Stable spatial demand prepares one privately owned spawn-candidate artifact.
Observed support can reuse its identity without scanning the packed bytes on
every animation frame. The mutable-view spawn API still detects in-place edits;
`renderer.spawn.candidateComparisonCount` distinguishes content checks from
prepared identity reuse. See [ADR-132](../../docs/decisions/ADR-132-flow-prepared-spawn-candidates.md).

The default is Flow Layer-style colored particle trails over MapLibre. The bottom
timeline controls play/pause, continuous model-time seeking, signed playback rate,
and loop/clamp. Requested and presented times remain distinct while data loads.
Rate uses the dataset's model-time unit per wall-clock second. The inherited particle
motion scale is visual; it does not reinterpret unconfirmed source units.

Use the inspector for speed, direction, U/V components, or sampling status. Lower,
upper, interpolated, and upper-minus-lower values all use the same tiled temporal
sampler. Status colors are green for resident moving data, amber for fallback,
gray for zero velocity, magenta for unavailable data, and red for invalid sampling.
Activity contour is an optional velocity threshold overlay and does not enter trails.

The Boundary selector offers four explicit comparisons. A remains the default;
C/D are opt-in center-field reconstructions, described after the existing A/B rules.

## Trail quality

The inspector's **Trail quality** defaults to **Balanced** for smoother playback
on large/high-DPR displays. Only trail history and particle overlap depth are
limited to one texel per reference pixel and a 1080p pixel budget; the Surface,
basemap, text, contour overlay and diagnostic views remain at native resolution.
**Native** retains the original fine trail rasterization. You can also open
`/flowField/?trailQuality=native` to choose it at startup.

Balanced trades trail detail for lower GPU work, and may change line thickness
and density. It does not lower the raster's source resolution, alter camera cover,
or reduce particle count. Changing quality only reallocates history when the
resolved dimensions differ. That clears existing ink without resetting particles;
while paused, trails can remain empty until playback resumes. See
[ADR-133](../../docs/decisions/ADR-133-flow-trail-pixel-budget.md).

With the development server and prepared Flow dataset running, verify with:

```sh
node tests/browser/flow-field-trail-quality.mjs
```

## Visual time and paused inspection

Particle motion and trail decay use a **60 Hz visual reference**, separately from
the timeline's model-time **Rate**. One admitted frame supplies one monotonic
wall-time value to the visual clock and all its consumers. An accepted interval
contributes `s = 60 × min(elapsedSeconds, 0.05)` reference steps. Thus 30/60/120 Hz
updates normally advance by 2/1/0.5 reference steps, not one displacement per
submission. Rate and playback direction continue to select model data; they do
not multiply the inherited visual displacement scale of 50. No speed/time control
parameter is added.

Particle displacement scales by s and the per-reference-tick retirement probability
p becomes `1 - (1-p)^s`; s=1 retains the original probability exactly. Predicted
substeps follow movement distance relative to the requested source texel, not
`ceil(s)`, which would turn tiny clock jitter into extra U/V sampling for every
particle. The configured base count is retained and the prediction is capped at
16; this is finite integration sampling, not continuous boundary collision.
Age and stagnation retain their u32 fields and
the 56-byte record: the clock distributes whole reference ticks with a shared
fractional remainder. Their phase uncertainty is at most one reference tick.
Stagnation compares displacement per reference step, so 120 Hz half steps do not
turn normal slow motion into a stationary particle. Actual zero/below-threshold
velocity still causes immediate death during simulation.

Trail decay is **not** an exponential replacement for the old byte-quantized
formula. The existing history pass applies `floor(255*color*0.996)/255` zero through
three times according to the whole-tick count, then applies the original cutoff.
At 120 Hz this normally alternates zero/one decay operation; at 30 Hz it runs two.
The textures and render-pass count are unchanged. A zero-tick copy does not decay
or apply the cutoff. Both particle time and history ticks discard any interval
beyond the 50 ms accepted cap; intervals over 250 ms reanchor with zero advancement.
There is no accumulated catch-up debt after a long pause, seek/reset, or temporal
suspension. The first admitted frame after resuming also only reanchors.

Paused camera/Boundary/Feather changes reproject or reclip existing history without
simulating particles or drawing the old line segment again. Controls therefore do
not add a hidden simulation step or brighten repeated segments. **Explicit resets
still clear history:** seeking, changing View/Sample, or toggling Particle trails
while paused can leave the particle view empty. There is no hidden warm-up;
resume playback to generate new particle ink. Pausing itself does not clear the
existing trails. See [ADR-119](../../docs/decisions/ADR-119-flow-reference-visual-time.md).

## Spatial work and performance

The example reuses its last successfully observed cover/demand decision while the
view identity, camera facts and logical reference viewport are unchanged. Normal
time interpolation, temporal-runtime changes and residency publications continue
without rebuilding the same spatial decision. Current demands still carry current
frame/residency provenance and belong to the current time slice's address space.
The cached GPU feedback retains its original producing view and receipt.

Camera, FOV or reference-viewport changes rebuild; staged, failed or disposed work
is never reusable. This does not change the Geo cover algorithm or its quality,
overflow and adjacency rules. `renderer.viewDemand.buildCount/reuseCount` count
encoded spatial batches, while `latestSettledFrameEpoch` identifies the last real
GPU spatial result. See [ADR-120](../../docs/decisions/ADR-120-flow-spatial-decision-reuse.md)
and the [per-phase benchmark record](../../docs/review/flow-pipeline-optimization-benchmarks.md).

History can accept a synchronous content producer in place of its existing draw
array. It uploads history uniforms first, then lets the caller append particle
and optional contour preparation before cache/history rendering. The common
steady path can therefore keep all hot uploads ahead of compute. This does not
change Scratch queue semantics or the frame-in-flight budget. Producers must not
submit, reenter history or return asynchronous work; a failed builder must be
abandoned through the caller's existing lifetime cleanup. See
[ADR-124](../../docs/decisions/ADR-124-flow-content-upload-order.md).

## A/B: original source-footprint boundary

In **Particles**, the **Boundary** selector compares **A · Hard texture** (default)
with **B · SDF (inward)**. B derives temporal support weights from endpoint
and interpolated U/V, then integrates binary SDF coverages across those activity
levels. Each supported sample occupies its **original texel square**. Inside the
wet union, distance is measured to the nearest unsupported square, including its
corners, and an inward feather is applied (default: 0.25 source texel). The distance
and support now use the same boundary: a center-point diamond is not subsequently
cut by a different square mask. Diagonal wet texels do not gain a bridge across a
dry gap. This is a truncated wet-side SDF evaluated in shader registers, not an
uploaded SDF texture or a JFA pass. See
[ADR-116](../../docs/decisions/ADR-116-flow-owner-footprint-sdf.md).

Both-endpoint supported centers retain weight 1, even when their vectors reverse or
the current speed is much smaller. Weak but valid interior motion is not mapped to
low opacity. Only the changing-support fringe (one endpoint supported, one not)
uses temporal interpolation and cancellation fading. Sorted weights give an exact, deterministic
coverage integral; this is **not** interpolation of two endpoint SDFs or a stateful
wall-clock smoothing filter. Uniform support weight q produces coverage q; binary
support preserves the spatial basis. Current velocity still controls particle death;
finite history visibility now uses the separate source-support rule below. See
[ADR-113](../../docs/decisions/ADR-113-flow-persistent-interior-support.md), correcting
the global opacity policy in [ADR-112](../../docs/decisions/ADR-112-flow-temporal-boundary-coverage.md).

With B selected, **Feather** adjusts the inward fade width from **0.05 to 0.35 source
texel**, in 0.01 UI steps. Smaller is sharper; larger makes a wider inward transition.
It does not move the reconstructed zero contour or change the activity threshold.
The numeric readout and keyboard arrows use the same source-texel units, not screen
pixels. Changes apply while dragging and preserve raw history and particle state.
A and inspector views disable the slider but retain its value for the next B view.
Programmatic `sdfFeatherTexels` inputs default to 0.25 when omitted; non-finite or
out-of-range values are rejected rather than silently changing the user's input.

Both choices use exactly the same particles and finite, decaying raw trail history.
The **visible result** is separate from the stored raw trails: a moving cancellation
curve neither erases a lasting scar nor automatically makes a supported interior
transparent. Reliable zero/below-threshold particles still die immediately.
For nonadvectable v3 samples only, A derives a display coverage from the
four registered source-center support bits at each time. The bits are bilinearly
interpolated, gated by each endpoint's original integer owning texel, then mixed
at the current model time. Two fully supported endpoint interiors give coverage 1;
two unsupported owners give 0. Partial/one-sided support is weighted rather than
using a pair-dependent Boolean exemption. Failed, unknown, legacy and outer-boundary
cases retain conservative behavior. B uses A for unavailable/legacy reconstruction,
but its known-resident square-union SDF is the sole display support rule: no second
stationary coverage or current-speed mask is multiplied afterward. Common supported
interiors still retain finite ink during reversals; two unsupported endpoint owners
still cannot be painted. Partial stationary coverage differs intentionally from the
older center-SDF-times-A product. No history creates new particles or velocities.

Known-resident B coverage has consistent shared-time endpoints and owner-square
edges/corners. This does not promise all rendered pixels are continuous: A's hard
boundaries, LoD/readiness/source-extent changes and missing raw ink can still affect
visibility. Source support remains inferred from U/V, not a physical wet/dry truth.
See [ADR-115](../../docs/decisions/ADR-115-flow-slack-water-display-support.md).
The two existing textures alternate roles: compose raw ink into one, then overwrite
the consumed source with its clipped visible image. During unavailable time loading,
only the last visible image is reprojected to the Surface; hidden raw ink stays hidden.
No texture or source channel is added. A separate display copy preserves nearest
scaling when Surface and history sizes differ. A and B each evaluate support only
in presentation. See
[ADR-114](../../docs/decisions/ADR-114-flow-trail-retention-and-visibility.md).
An MRT experiment passed device-local quantization tests but did not establish a
stable improvement in the complete display interval, so it is not enabled. Its
preserved experimental branch and corrected timing evidence are recorded in
[ADR-122](../../docs/decisions/ADR-122-flow-paired-visible-presentation.md).

Switching A/B neither resets nor softens raw history, changes velocity/death, nor
adds source requests. B cannot extend color into zero-support owner footprints,
make every raster contour curved, restore missing narrow channels, or increase z10 precision.
It is deliberately an **inner-edge display comparison**, not reconstructed true banks.
The distance uses source texels, so DPR/pitch do not redefine its width. At minification
this is not a replacement for screen-space antialiasing.

After checking the actual sampler's common level and readiness through its public
metadata/transition operations, B reads the owning
sample and only neighboring squares within the feather width. A 3x3 neighborhood
is sufficient; with width below .5, at most four samples per endpoint are needed
for this geometry, in addition to metadata checks; fallback can invoke the full
velocity sampler. Unrelated distant
neighbors are not sampled. Relevant
unknown/missing halo, fallback or an unavailable temporal capture
uses the unmodified A display, not a fabricated dry contour. Current alpha is evaluated
each time: opposite endpoint velocities can cancel, and a zero endpoint can activate.
No endpoint SDF interpolation or alpha-independent spawn-union cache is used. B adds
fragment work and one stable pipeline, but no texture, CPU raster, readback, compute
dispatch, or backend channel. Inspector views and activity contour remain raw; their
disabled Boundary control retains the selection for the next Particles view. See
[ADR-110](../../docs/decisions/ADR-110-flow-boundary-sdf-comparison.md) and the
[continuity correction](../../docs/decisions/ADR-111-flow-continuous-boundary-distance.md).

## C/D: source-center distance reconstruction

**C · Center SDF (linear)** and **D · Center SDF (smooth)** use the same four signed
distance samples at source centers. Each time endpoint classifies existing U/V
samples with the existing nonzero/activity-kill rule. At each center, distance is
positive inside support and negative outside, measured to the nearest opposite
unit-square footprint and truncated at 1.5 source texels. A bounded local GPU
buffer now caches these endpoint samples from the existing U/V pages. There is no
new network boundary tile, CPU raster/decode, GPU readback, or backend change.
The direct register-only reconstruction remains the cache-miss path and reference.

C uses ordinary bilinear reconstruction. D replaces each fractional coordinate f
with `f*f*(3-2*f)` before the same four-value mix. Unlike B's exact square boundary,
these reconstructed zero contours may cross the original owning-texel footprints.
There is no second original-owner hard mask. The smooth kernel changes the shape,
not just the opacity, but is not a more accurate distance metric: a straight
crossing at 0.25 can move to approximately 0.32635. Neither option restores lost
source detail or guarantees narrow-channel/island topology.

The two endpoint center distances are mixed at model time before spatial
reconstruction. This is a continuous visual shape morph, not a hydrodynamic
wet/dry model; a zero U/V center is not proof of physical dryness. Nonzero endpoint
vectors cancelling between times do not erase the supported interior's finite ink.
Feather remains **0.05–0.35 source texel** and applies
`smoothstep(-feather, feather, distance)` around the reconstructed zero contour.
It is display antialiasing width, not contour smoothing strength, and is still not
screen-pixel antialiasing at minification.

C and D also use ordinary registered center-interpolated U/V for particle motion,
without the A/B rule that extends a zero center over its entire owning square.
Actual zero/below-threshold interpolated motion still kills the particle; there is
no boundary sliding or immortal stationary particle. C/D have identical particle
sampling, so their comparison isolates the distance reconstruction kernel. A/B,
inspection values, and activity contours keep their original sampler policy.

The pixel-center adapter uses each endpoint's four loaded Geo Samples for both
readiness/level arbitration and bilinear interpolation, avoiding repeated
resolution-only queries. Geo still owns every logical texel/atlas access. The
adapter's existing no-payload-NoData restriction, status precedence, common-level
re-registration and edge transitions remain unchanged. See
[ADR-121](../../docs/decisions/ADR-121-flow-loaded-footprint-reuse.md).

The common-level/readiness proof and half-texel registration remain shared with
the existing sampler. Each cached pair-page has **257×257 packed u32 records**,
including the shared next row/column. One record encodes both endpoint distances,
signs and uncertainty. A cached display query reads four records. At the matching
publication epochs their owner-known flags already prove exact source-center
residency, avoiding eight repeated resolution lookups. The sampler's cross-level
edge-transition checks remain, and required unknown source data still uses A.
Shared-sign interiors return before distance decoding; mixed boundaries reuse the
same four packed records and the original sqrt arithmetic without further reads.
A cache miss, an omitted page, or an incompatible cache uses the original direct
C/D reconstruction. That direct path costs eight U/V loads in common supported or
unsupported interiors, or up to 32 for the full 4x4 neighborhood, plus metadata
checks. Cache absence is not source absence and never creates a dry contour.

The cache is owned and disposed by history. It uses at most **48 pair-pages**:
the records occupy **12,681,408 bytes (12.094 MiB)** at capacity, plus a four-byte
lookup entry per source page-table entry, up to 768 bytes of jobs, and 16 bytes of
configuration. This is additional local GPU storage, not a zero-resource change.
The page planner validates all input identities, selects the requested level,
sorts/deduplicates by source table index and keeps the first capacity pages. Other
pages retain lookup zero and use direct reconstruction; source demand is unchanged.

The selected page set is invalidated when endpoint runtime/publication, requested
level/page set, or source allocation facts change. If the page plan is unchanged,
an endpoint matching the last successful build can keep its packed byte, including
when the old upper endpoint becomes the new lower. Only changed endpoints read U/V
again. Owned cache content/allocation versions must also match before reuse.
This is conservative per-endpoint whole-set invalidation, not per-page/halo
dependency tracking. Alpha, C/D choice, Feather, and the camera itself
are not cache keys; camera-induced selected-page changes still rebuild. The build
runs after the source publication uploads and before dependent presentation in
the same submission. Only an observed successful submission containing the build
can publish its reusable nonempty key. Failed or abandoned builds cannot be reused.
No extra network requests or render passes are added; a local compute pass runs
only when rebuilding. See [ADR-117](../../docs/decisions/ADR-117-flow-center-sdf-reconstruction.md)
for the unchanged shape model and
[ADR-118](../../docs/decisions/ADR-118-flow-source-center-distance-cache.md), which
supersedes only ADR-117's direct-execution/cache-cost decision.
Endpoint reuse uses the existing build-job padding, with no extra texture or
network data; see [ADR-123](../../docs/decisions/ADR-123-flow-center-endpoint-reuse.md).
`rebuiltEndpointCount/reusedEndpointCount` count lanes in encoded build batches;
`lastReuseSelectors` identifies fresh/previous-lower/previous-upper lanes. They are
not counts of fragment cache hits or successful native completions.

## Source data and streaming

New v3 COGs store ordinary triangle-linear center velocities without neighborhood
erosion. Their zero-absorbing 2x2 overviews also omit the extra 3x3 erosion. The
manifest explicitly requests `nearest-texel-zero` activity: each zero texel's whole
footprint stays inactive, while nonzero footprints keep ordinary bilinear velocity
and time interpolation. Old v2 data remains readable under its original contract.
See [ADR-107](../../docs/decisions/ADR-107-flow-zero-footprint-cog-support.md).

The bounded spawn index examines every source texel in each group, using a subcell
mask in the existing 32-byte record instead of checking only the group center.
Observed endpoint-union support is reused across alpha changes; page/pair/content
changes rebuild it. Birth still validates the current interpolated velocity, so
future support or opposing endpoint vectors cannot create a stationary zombie.
No candidate-capacity, texture or backend-channel increase is required; see
[ADR-108](../../docs/decisions/ADR-108-flow-subcell-spawn-support.md).

While playing through camera/LoD changes, available flow continues to animate using the current
temporal capture. Missing data suspends only affected particles without redrawing
their previous segment; this active visual time still consumes their finite lifetime. Missing or
conservative coarse-zero support does not immediately erase trails: those pixels
follow the map and decay normally. Reliable resident zero and source exclusion still
retire particles and clear unsupported ink.

Full-view completeness remains separate from local animation. Loading and the old
presented time remain visible until feedback and requested pages agree. Inspector
views retain their complete image, and the optional contour is hidden during this
wait. A pending explicit seek/loop reset or a loading temporal runtime still uses
the retained-image path; the reset must happen before drawing the new particle pool.
Residency completion updates readiness automatically even with model playback
paused; it does not advance paused particle simulation.
Fallback is always reported relative to the original sampling request, including
when a coarser page contains zero velocity. Changing the inspection mode explicitly
invalidates the old image rather than relabeling it.

While playing, one next sample in the playback direction is prepared ahead of the
active pair. The same current-view detail pages are requested with background
priority and uploaded through the existing GPU submission/acknowledgement path.
During camera motion, lookahead may use the latest observed bounded spatial plan;
completion of that plan is not a claim that the newest camera is fully covered.
This stays inside the four-runtime aggregate budget, including captured and retiring
runtimes. Completed unchanged plans incur no repeated prefetch publication work.
Pause cancels speculation; gaps are not silently crossed. Seeks, discontinuous loop
wraps, changed views, high rates or slow sources can still use the retained loading
path. Factory readiness alone does not mean current-view pages are GPU-ready. See
[ADR-105](../../docs/decisions/ADR-105-flow-directional-lookahead.md).

Flow-specific controls, screen projection, particles, and history stay local to this
example. The former `flowLayer` is a frozen rendering reference. See
[ADR-098](../../docs/decisions/ADR-098-flow-field-reference-presentation.md) for the
reference mapping and the numerical differences introduced by tiled sampling.

Focused native proofs:

```sh
node tests/browser/flow-screen-projection.mjs
node tests/browser/flow-field-particle-reference.mjs
node tests/browser/flow-field-history.mjs
node tests/browser/flow-field-history-recovery.mjs
node tests/browser/flow-field-history-retained.mjs
node tests/browser/flow-field-history-time.mjs
node tests/browser/flow-field-visual-time.mjs
node tests/browser/flow-field-slack-interior.mjs
node tests/browser/flow-field-controls.mjs
node tests/browser/flow-field-contour-order.mjs
node tests/browser/flow-field-boundary-distance.mjs
node tests/browser/flow-field-boundary-time.mjs
node tests/browser/flow-field-boundary-interior.mjs
node tests/browser/flow-field-boundary-sdf.mjs
node tests/browser/flow-field-boundary-readiness.mjs
node tests/browser/flow-field-boundary-ab.mjs
node tests/browser/flow-field-center-distance.mjs
node tests/browser/flow-field-center-cache.mjs
node tests/browser/flow-field-center-sdf.mjs
node tests/browser/flow-field-center-ab.mjs
node tests/browser/flow-field-normal-startup.mjs
node tests/browser/flow-field-temporal-status.mjs
node tests/browser/flow-field-zero-footprint.mjs
node tests/browser/flow-field-spawn-subcells.mjs
node tests/browser/flow-field-inspector-handoff.mjs
node tests/browser/flow-field-motion-performance.mjs
node tests/browser/flow-field-reveal-index.mjs
node tests/browser/flow-field-camera-reveal.mjs
node tests/browser/flow-field-camera-continuity.mjs
node tests/browser/flow-field-spatial-handoff.mjs
node tests/browser/flow-field-lookahead.mjs
node tests/browser/flow-field-prefetch-failure.mjs
node tests/browser/scratch-flow-field.mjs
```

Run the motion benchmark alone: it compares high-DPR submission frequency against
frozen Flow Layer and an isolated eager-presentation-support counterfactual. Also
inspect accepted `visualTime` and encoded `simulatedReferenceSteps`: submissions
are no longer equivalent to one particle reference step. These are timing/encoding
facts, not GPU position readbacks. Empty
ink skips temporal-raster sampling in the final presentation; raw history never
samples velocity. This preserves the visible-ink optimization from
[ADR-102](../../docs/decisions/ADR-102-flow-history-visible-support.md) after moving
the visibility check out of destructive trail accumulation.

With Vite and the tile service already running,
`node tests/browser/flow-field-reference-appearance.mjs` saves both examples at
the same camera for visual comparison without changing the reference.

`node tests/browser/flow-field-camera.mjs` checks continuous zoom, paused zoom,
retained-history reprojection during delayed time loading, and steady animation
throughput. Large view demands select a coarser complete cover within the existing
page budget; they do not increase the budget or discard arbitrary visible tiles.

When camera movement reveals new supported flow, a bounded GPU index directs
replacement particles into that region once the current view's pages are ready.
It preserves history and normal stationary retirement, with no extra source data
or texture. The quota uses candidate counts rather than exact projected area; see
[ADR-103](../../docs/decisions/ADR-103-flow-camera-reveal-refill.md).

Per-position uncertainty handling prevents loading-time samples from erasing old
trails without freezing the whole field; see
[ADR-106](../../docs/decisions/ADR-106-flow-local-streaming-motion.md).
Targeted reveal refill still waits for a complete view. During continuous expansion,
newly exposed regions may temporarily be less dense while existing flow keeps moving.

`node tests/browser/flow-field-pitch.mjs` checks tilted particle and Speed views at
model time 6.93, including screenshot colors against COG U/V samples.
`node tests/browser/flow-field-pitch-projection.mjs` checks real MapLibre camera
unprojection on GPU at 0/60/75/85 degrees and DPR 1/2.

`flow-field-boundary-source.mjs` compares separately served v2 and v3 data at the
same fixed camera/time (URLs through `FLOW_BOUNDARY_OLD` / `FLOW_BOUNDARY_NEW`). It
checks restored Speed/particle coverage and actual reuse of the observed spawn index.
It does not treat a basemap shoreline as model truth. A z10 source remains roughly
130 metres per texel here, so subpixel channels/banks still need finer source data.
