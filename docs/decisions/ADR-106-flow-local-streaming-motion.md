# ADR-106: Local Flow Motion During Streaming

## Status

Accepted for Flow Field. Supersedes ADR-104's shared particle/full-view gate, but
retains its completeness, diagnostic-view and explicit-reset protections. Scratch,
Geo, the frozen Flow Layer, backend payloads and resource budgets are unchanged.

## Date

2026-09-06

## Context

ADR-104 prevents missing detail and conservative coarse zeros from destroying a
previously complete image. Its shared readiness gate also freezes every particle
whenever one-frame-delayed demand feedback differs from the current camera. A
continuous-camera proof observed particle advancement in only 64% of pan frames,
40% of pitch frames and 5% of wheel frames. Pan and wheel made no new tile requests.
Camera equality is therefore not equivalent to usable velocity at a particle.

## Local Sampling Decision

Every particle position and tentative integration substep uses only the current
temporal capture and its ordered GPU publication. Reliable moving resident/fallback
samples advance normally. Resident zero, below-threshold motion, invalid sampling,
and explicit source exclusion retain absorbing retirement. Inside-source missing
data and a non-advectable coarse fallback are unknown, not proof of fine-resolution
stationary water. Source containment is queried again only for status zero, which
otherwise conflates an outside-source position with an unresolved inside position.

An active particle meeting unknown data retains its canonical position, sets
previous equal to current and clears velocity. It draws no repeated segment and
does not randomly relocate merely because a page is missing. A missing substep
rolls back the entire tentative step. Waiting increments the existing finite age
counter, not the displacement-stagnation counter, and remains bounded by the same
maximum particle lifetime. Saturating increments cannot wrap at u32 maximum.
Natural retirement, rebirth validation and zero-length birth remain unchanged for
reliable samples. There is no new particle record, source channel or position owner.

History distinguishes unknown support from confirmed invalid support. Unknown
pixels are reprojected and undergo normal quantized decay, rather than immediate
erasure or indefinite retention. Confirmed zero/domain exclusion still clears ink.
Empty/faded pixels still skip velocity sampling. This keeps retention finite
without another history texture or per-pixel age plane.

## Renderer Admission

Full-view completeness still requires current-camera feedback, matching requested
level and resident pages at both temporal endpoints. The renderer checks page
failures independently of camera equality, and scans all selected pages/endpoints:
an earlier missing page must not hide a later terminal failure.

Particles may execute on every ready temporal capture without full-view equality.
The frame exposes `particlesAdvancing` separately from `presentationReady`; the
former is encoded work, not a CPU observation that every particle actually moved.
Per-position sample decisions govern local advancement and history support.
Each query uses the current pair and publication, never a previous pair's velocity.
Ordinary adjacent time transitions therefore do not reintroduce a camera-equality
wait. Window/factory loading retains its existing temporal-independent image path.

A pending explicit visual reset is different: seek/loop/reset waits for complete
presentation, then resets before any new particle work. Local admission cannot
let an old particle pool draw across a deferred reset. Inspector and contour still
require complete presentation, and UI presented time advances only after a complete
image is observed. Local motion is not a claim that all current pixels are ready.

Only a complete view consumes the targeted reveal baseline. Partial frames use
normal valid rebirth, never repeat a one-quarter reseed of the same unknown region.
On continuous expansion, newly visible regions may remain less dense until normal
retirement or the complete-view refill; this is distinct from stopping existing flow.

Directional lookahead also remains live during local particle work. It may warm the
latest bounded plan derived from observed feedback while feedback chases the camera.
Its page-complete marker refers to that explicit plan, not proof of complete coverage
of an as-yet-unobserved camera. No stale feedback is relabeled as full-view readiness.

## Verification

Native particle tests cover hold, recovery, age expiry, u32 saturation, missing
substep rollback, source exclusion, resident zero, invalid input, displacement,
random retirement and bounded reveal refill. Native history tests cover unknown
retention with finite decay, authoritative zero/exclusion, reprojection and the
empty-history sampling optimization. Production resources retain their existing ABI.

`flow-field-camera-continuity.mjs` drives real continuous pan, pitch and wheel input
and checks particle-step admission per submitted frame rather than a machine FPS
threshold. The old gate fails even with no new tile requests. Spatial handoff and
explicit-reset proofs check partial drawing, honest completeness, retained ink,
delayed reset, automatic residency recovery and zero-resource disposal.

The integrated run admitted one particle step per submitted frame for stationary,
pan, pitch, wheel and default-rate wheel playback. The last case crossed two
ordinary time-pair handoffs while the camera continued changing. These are kernel
admission measurements; the native per-position fixtures separately prove that
unknown particles hold while reliable samples move. The isolated zoom-9,
1512 × 861, DPR-2 motion benchmark measured 59.63 steps/s against the frozen
reference's 59.92 steps/s, with no console errors in either path.
