# ADR-122: Evaluate Paired Presentation And Retain Cheap Center Decoding

## Status

Evaluated; MRT not adopted on the main branch. The numerically verified experiment
is preserved as `5b2b063` on `socu/flow-mrt-evaluated-9b3a4e1`. Only delayed source-center distance
decoding and corrected benchmark interval measurements are retained in mainline.

## Date

2026-09-08

## Context

After spatial and velocity-sampling work was reduced, normal Flow Field still
performed three full-screen draws: raw history composition, visible boundary
clipping, and visible-to-Surface copy. The visible intermediate is required by
the temporal-unavailable retained path; removing it or feeding clipped values
back into raw history would reintroduce persistent cancellation scars.

The old Surface copy observes alpha after an `rgba8unorm` store/load. Returning the
unquantized clipped alpha directly from a paired render changes pixel values.
Ordinary WGSL `round(alpha * 255) / 255` is also not equivalent on the measured
Metal backend at half-LSB boundaries.

## Evaluated MRT Design (Not Adopted)

Keep raw history composition unchanged. When history and Surface have matching
physical dimensions, the following boundary pass writes two attachments:

```text
new raw -> original unblended clipped RGBA -> retained-visible texture
        -> quantized alpha + original RGB -> NORMAL_BLEND -> Surface
```

The visible texture remains the consumed previous raw texture, so the two existing
history textures retain their roles and allocation budget. The Surface output
uses `unpack4x8unorm(pack4x8unorm(color)).a` for intermediate alpha. RGB already
comes from byte history and is not premultiplied before the existing blend state.
The visible attachment receives the original clipped value and native conversion,
not a different coverage function. Empty-ink returns are preserved, not replaced
by discard.

Each boundary shader exposes one color helper used by its original single-output
entry and the paired entry. The independent numerical proofs can still compile
the original single-output entry. No-data inspection and retained-only presentation
keep their existing Surface paths. If history and Surface dimensions differ, use
the original clipping plus copy path so the valid nearest-copy scaling composition
is preserved. This is an attachment-compatibility choice, not a user feature flag.

## Retained Mainline Change

In the source-center cache fragment helper, retain the four packed records and
check owner/sign/halo facts before decoding distances. Full wet/full dry interiors
return before sqrt; mixed boundaries use the exact preceding distance arithmetic.
Owner-unknown precedence and the same-sign exemption for irrelevant unknown halo
are unchanged. There are no additional cache reads, textures or source channels.

## Verification

The native quantization preflight tested 595,200 samples for each of `rgba8unorm`,
`bgra8unorm` and `rgba16float`, including all alpha bytes, half-LSB coverage points
and adjacent f32 values, colored transparent pixels and black pixels. Pack/unpack
alpha produced byte-identical retained and Surface outputs on the tested device;
unquantized and ordinary-round controls produced differences. The experimental
commit's test uses its production helper and asserts equivalence on tested formats.
This is device-local evidence, not a proof of every backend's format conversion.

Native center-cache coverage retained zero difference over 108,490 comparisons.
Full graph tests must separately check A-B-A texture roles, pause/reclip, unavailable
time retention, resize including mismatched dimensions, cleanup and all boundary
modes. Performance is measured separately from pixel-readback validation in the
[per-phase benchmark record](../review/flow-pipeline-optimization-benchmarks.md).

## Consequences And Rollback

The initial estimate added individual render-pass durations and was invalid:
adjacent render passes can overlap on the measured backend. A corrected contiguous
visible-begin to Surface-end ABBA measurement gave separate-pass means 2.308/2.306 ms
and MRT means 2.320/2.230 ms. This did not establish a stable material improvement.
Consequently the extra MRT pipeline family is not adopted by default. Fewer draws
do not by themselves prove lower busy time or a shorter critical path.

The evaluated equal-size path removes one full-screen texture read/draw and one render
pass while retaining both history textures. Its extra pipeline variants support paired
and scaled presentation; no native graph object is constructed per frame. This
does not remove particle or source-center build work, nor change submission limits.

The mainline phase follows sampler commit `9b3a4e1` and is committed independently.
Reverting it restores eager center-distance decoding without undoing spatial or
sampler optimizations. The MRT experiment remains separately recoverable through
`5b2b063`; no backend artifacts need migration.
