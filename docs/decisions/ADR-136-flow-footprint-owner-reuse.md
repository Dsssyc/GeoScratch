# ADR-136: Reuse Loaded Flow Footprint Owners

## Status

Accepted. Example-local sampling optimization following ADR-121/134. Source
semantics, public Geo WGSL defaults, metadata ABI and particle records are unchanged.

## Decision

The pixel-center adapter accepts an explicit original position and owner-veto flag
in its internal support entrypoints. After all four loaded corners pass the same
status, resolved-level and transition checks, it selects the unregistered owner
from those corners when its integer offset lies inside the loaded 2x2 footprint.
An exceptional owner outside the footprint still uses the full load-position
accessor. Zero-owner masking changes only velocity components, as before.

The temporal wrapper consumes the support-aware samples and retains its complete
common-level retry and failure precedence. C/D disable the veto. Existing plain
two-argument registration samplers remain unmasked. Global-lattice registration
retains its full independent owner lookup. All data flows through function values;
there is no hidden invocation-global cache or cross-frame sample lifetime.

This removes two redundant owner loads from an ordinary A temporal query, reducing
ten texels to eight logical loads. It does not remove the particle's new-position
query, status validation, finite integration or source-cell substep policy.

## Verification

The real generated-sampler oracle compares 6,204 samples across 47 fixtures,
including source/page seams, zero-owner cancellation, missing/failed data, mixed
fallback, registration and non-owner C/D sampling. Values and status metadata match;
the ordinary A case observes eight loads against ten for the independent old owner
lookup. This oracle shares the current temporal wrapper, so an additional actual
particle replay checks the complete recorded pre-change shader independently.

The recorded shader SHA-256 is
`e354d94aafd702bc117a8e40648fb8319bd622a94e5337c21ecb88c8a763a443`.
On the same 262,144-particle input its output matches the new shader byte-for-byte.
Ten interleaved samples measured 2.407 ms recorded versus 2.152 ms current on Apple
Metal 3. Keep 256-thread production workgroups; the isolated 64-thread variant is
not adopted based on one frame. These are simulation-pass timings, not whole-page
FPS savings.

Revert this commit to restore independent owner loads without changing data,
resource ownership, default Geo shader generation or frozen Flow Layer.
