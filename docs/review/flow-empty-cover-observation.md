# Flow Field: Empty Cover Observation

## Status

Open, independently reproduced while verifying ADR-104. Not fixed by that change.
No Geo cover validation is bypassed or downgraded in the Flow example.

## Reproduction

Use an isolated headless Chrome page, viewport 1440 by 900, with
`/flowField/index.html?proof=1&rate=0.001&zoom=3`. Wait for Ready, pause playback,
then drag the map horizontally from `(100,450)` to `(1400,450)` in 26 increments
of 50 pixels, about 35 ms apart. After the source region leaves the view, the page
enters Error rather than producing a valid empty demand. A reverse drag cannot
recover the stopped controller.

The same result occurs in an isolated browser restoring the previous sticky
pair-generation presentation gate. It is not introduced by ADR-104's per-view gate.

## Observed Feedback

Both gate variants reached `gpu-web-mercator-quad-cover.ts` feedback validation
with these values (only the frame epoch differed):

```json
{
  "candidateCount": 812,
  "patchCount": 0,
  "descriptorOverflowCount": 0,
  "lookupOverflowCount": 0,
  "minimumMatrixLevel": 4294967295,
  "maximumMatrixLevel": 0,
  "maximumAdjacentLevelDelta": 0,
  "finestMatrixLevel": 4,
  "minimumCellSpanQ8": 4294967295,
  "maximumCellSpanQ8": 0
}
```

This fails before a current empty source-demand result can reach the renderer.
Determine whether the zero-patch output is a legitimate empty cover or a selection
defect before changing the validator. Any core repair needs the repository's full
cover/terrain verification gates, separate from the example-local handoff fix.
