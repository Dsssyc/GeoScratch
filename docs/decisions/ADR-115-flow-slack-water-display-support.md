# ADR-115: Preserve Finite Flow Ink Through Interior Reversals

## Status

Accepted. Refines ADR-114's final visibility rule without changing its two-texture
raw/visible ownership. Particle velocity sampling, death/spawn thresholds, lifetime,
backend data, source requests, A/B selection and SDF spatial basis are unchanged.
This is example-local presentation; no public Scratch/Geo contract changes.

## Date

2026-09-07

## Evidence

At t22/t23 near alpha .63 and .69, actual source data contains opposing vectors and
moving sub-threshold regions. A strict visibility gate clears those pixels even
though their raw trails still contain ink. In isolated fixed-camera/time checks,
reducing only the display threshold by ten shrank representative holes from 249/693
pixels to 2/5; restoring the original threshold restored the same pixels. Actual
z10 pages were ready. This is distinct from the destructive raw scars in ADR-114.

Current station-derived Delaunay data also contains cancellation zeros. Sampling
that field onto z10 and applying bilinear interpolation shifts representative zeros
by about 12-30 projected meters; corner values match the builder exactly. Neither
these inferred triangles nor the interpolated intermediate state are confirmed
original hydrodynamic topology/truth. Increasing resolution does not remove a
visibility policy that clips every low-speed point.

## Decision

Keep the actual temporal vector sampler and all particle death/lifetime behavior.
Only presentation can reveal still-decaying historical ink at a nonadvectable point.
Both A and B use the same shared example-owned shader support functions.

For an exact resident nonadvectable v3 sample:

1. Obtain the actual lattice with the sampler's wide-fixed half-texel registration,
   not by subtracting .5 from an already rounded f32 fraction. Obtain the owning
   texel separately from the original unregistered integer address.
2. Read four centers per endpoint. Every queried center must exist inside both
   source bounds and be exact resident at that same level. Check bounds before
   `load_global`, which otherwise clamps. A failed proof grants no extra visibility.
3. Convert each stored velocity to support `speed > 0 && speed >= kill`. Bilinearly
   interpolate each endpoint's four bits and multiply by that endpoint's owning
   bit. Call these coverages g0 and g1. This respects zero/sub-threshold owning
   footprints instead of extrapolating neighboring support across them.
4. Set g = (1-alpha)*g0 + alpha*g1, with explicit alpha endpoint values. A uses g
   as visible alpha coverage. B multiplies its existing SDF coverage by g.

Advectable points retain their existing presentation. Unknown/fallback remains
unknown rather than dry; source-exterior and failed samples remain hidden. The
new stationary support rule is disabled for legacy representations. Empty ink
still skips all field work, and raw decay/retention never uses this coverage.

The helper tests the owning pair first and reuses those values: two unsupported
owners need only two additional texel reads; a successful full proof needs at most
eight, excluding the preceding velocity sampler and B's own SDF reads. Weights
are streamed without a dynamically indexed private array, clamped for rounding,
and full support is pinned to exactly 1. This bounds work but does not make the
new rule GPU-cost-free; performance is view- and workload-dependent.

Full support at both endpoints gives g=1, even when interpolated velocity cancels.
Both unsupported owners give g=0. Partial support gets a continuous weight. A
Boolean "all eight supported" exemption was rejected: changing only the other
neighbor of a shared zero-velocity sample could otherwise flip visibility at a
time-pair handoff. Bilinear endpoint coverage avoids that pair-dependent switch
and ordinary lattice-cell seams. No new texture, buffer, uniform, network field,
CPU rasterization, compute pass or persistent cache state is introduced.

## Limits

This deliberately allows finite historical ink where current particles are dead;
it neither holds those particles alive nor alters the sampled vector. History
still expires normally. Diagnostics continue to show actual U/V and speed.

Only g has the stated pair/cell continuity. The final switch from g to 1 when
current motion becomes advectable can still jump if g<1; source-owner hard edges,
missing proof neighbors, source bounds and LoD changes remain conservative. B's
existing one-endpoint fade is not removed. This does not reconstruct true banks
or promise every possible sparse/empty area disappears.

## Verification And Rollback

Native checks cover supported interior zero/low velocity, partial/one-sided support,
both zero owners, unknown/failed/coarse neighbors, exact wide ownership, shared
zero-speed time joins, A/B agreement, finite expiry and retained-image lifecycle.
The full-page slack-interior test restores the old strict gate only in its isolated
page, proves existing raw ink is clipped there, then checks A and B restore it at
the same model time without resetting particles. Existing death/reference and
camera/time/resize/loading/cleanup proofs must continue to pass.

The clean pre-change commit is e27f324, also retained by local branch
`socu/flow-before-slack-visibility-e27f324`. Land this slice as a separate commit;
revert that commit to undo it without deleting later history or source data.
