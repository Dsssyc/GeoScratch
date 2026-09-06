# ADR-106: Local Flow Motion During Streaming

## Status

Accepted for Flow Field's local sampling policy. Renderer admission is integrated
separately from this shader change. Scratch, Geo, the frozen Flow Layer, backend
payloads and resource budgets are unchanged.

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

## Verification

Native particle tests cover hold, recovery, age expiry, u32 saturation, missing
substep rollback, source exclusion, resident zero, invalid input, displacement,
random retirement and bounded reveal refill. Native history tests cover unknown
retention with finite decay, authoritative zero/exclusion, reprojection and the
empty-history sampling optimization. Production resources retain their existing ABI.
