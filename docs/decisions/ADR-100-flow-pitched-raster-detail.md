# ADR-100: Preserve Flow Raster Detail In Pitched Views

## Status

Accepted. Corrects the raster ancestor-removal rule in ADR-099. Geo geometry cover,
the frozen Flow Layer, source data, and the four-runtime budget remain unchanged.

## Date

2026-09-05

## Evidence

At zoom 10, a 1440 by 900 top-down view requested 42 z10 pages. At large pitch the
GPU geometry cover correctly contained coarse horizon patches and fine nearby
patches. Flow's source-demand adapter inserted coarse raster pages first and then
removed all descendants, incorrectly treating raster residency as a prefix-free
geometry cover. One z4 page consequently swallowed the near-field requests and
changed the entire frame's requested sample level from z10 to z4.

This caused both the disconnected Speed patches and weak speed values. In the
observed t06 artifact, z4 pixels are about 9.78 km versus about 153 m at z10.
Conservative coarse reduction removes narrow support and lowers peak velocity;
it cannot replace available foreground detail.

An independent native WebGPU check used actual MapLibre camera matrices at pitches
0, 60, 75, and 85 degrees with DPR 1 and 2. Forty screen-to-ground points matched
MapLibre unprojection within 0.02 m and projected back within 0.001 logical pixels.
The camera transform and DPR were not the cause of this defect.

## Decision

Raster demand deduplicates only identical matrix/row/column identities. Coarse
fallback pages and fine pages may overlap. Geometry's prefix-free invariant stays
with the geometry cover; it does not constrain the Virtual Raster page table.

The fixed page budget still applies. After expanding halos, over-budget demand is
retried at coarser caps. If overlapping levels would force the foreground below a
finer complete source level that fits the same budget, use that strictly better
complete level. This avoids spending more slots on a coarse hierarchy than on a
uniformly finer field. It does not raise requested precision beyond the original
request or increase physical storage.

Raster pages and particle spawn cells have different coverage rules. Keep both
coarse and fine pages resident, but omit coarse spawn cells intersected by finer
requested pages. For the current z4–z10 dataset and 64-cell page grid these divisions
are exact. Smaller grids conservatively omit partially intersected coarse cells;
this affects the birth candidate set, never raster coverage or sampling.

## Verification

- Unit tests retain z4 plus nearby z10 demand, check integer spawn-cell ownership,
  preserve the 47-page cap, and select complete z9 over a coarser mixed hierarchy.
- `tests/browser/flow-field-pitch-projection.mjs` records native camera projection
  and DPR accuracy against actual MapLibre unprojection.
- `tests/browser/flow-field-pitch.mjs` freezes model time at 6.93, changes pitch with
  actual right-button drags, and rejects loss of near-field detail. It checks
  particles at 85 degrees and samples Speed screenshot pixels against the actual
  COG tile bytes: bilinear U/V, component-wise temporal interpolation, reference
  color ramp, and alpha composition. This verifies sampled values, not just a
  nonempty image.

The observed pitched scenes now request z9/z10 detail instead of z4. At 85 degrees
the complete z9 field requires 36 pages. The COG's real resolution and its explicitly
budgeted level still limit how much spatial detail can be displayed.
