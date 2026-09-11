# Flow Sampler Metadata Evidence

Baseline: `e0dd5f6151fa8801ad8b3ea8480d40fdd3048401`.
Decision: [ADR-134](../decisions/ADR-134-data-driven-webmercator-raster-sampling.md).

## Result And Ownership

Flow Field uses Geo-owned immutable metadata uniforms for velocity sampling. Source
level mapping, coverage limits, page offsets, decoding, source bounds and pixel-center
registration no longer specialize its normal temporal sampler's shader. Each temporal
generation owns metadata bindings and retains its raster capture. Retired bindings
remain alive while old frames use them. Exact endpoints share one metadata allocation.

The metadata ABI is 1,808 bytes per source. Explicit mapped creation initializes
UNIFORM-only storage; it is never rewritten per frame. This adds no storage-buffer
slot, GPU readback, residency publisher or Scratch domain API. Coordinate precision
and sampling/registration contracts remain compatibility boundaries. Temporal pair
compatibility is unchanged. Default constant-generated WGSL remains byte-identical
to the baseline for tested vector and scalar/NoData models. Existing frozen GPU
reference hashes are unchanged; terrain and Flow Layer do not adopt this path.

## Native Correctness

`node tests/browser/geo-raster-sampler-metadata.mjs` changes A → B → C → A with
different coverage, missing source levels, bounds and decoding. One native metadata
pipeline serves every source. All 480 sample results match the constant-generated
sampler byte-for-byte, exercising missing, failed, NoData and resolved parent samples.

`node tests/browser/flow-field-sampler-reuse.mjs` compares the old preflight reference,
current footprint reuse and metadata sampling over 47 fixtures, 282 temporal cases
and 22 positions. All 6,204 metadata samples match the current sampler's velocity,
speed, status, resolved level and advectability. Cases include zero owners, reversals,
page seams, exact registration, mixed fallback and failure precedence.

Node tests verify sparse compact indices, independent packing copies, GPU metadata
ownership, mapped-range/unmap failures, and raster disposal during async creation.
The temporal provider rotates A → different-coverage pair → A without changing WGSL
or bind layout. It validates intent against the new level count and retains old
metadata until the last old frame releases its capture.

## Actual Particle Replay

Chrome reported Apple `metal-3` on the local M1 Max. The actual page used 1760×880
logical pixels, DPR 2 and Native 3520×1760 Surface/history. After warmup, one real
compute input/output was copied and the application stopped. Every replay restores
the same input; copies and hash readbacks are outside timestamp intervals. Timed
shaders contain no diagnostic counters.

Reference source interpretation is reconstructed from captured metadata and checked
against its entire packed byte image. The complete original shader recorded during
the earlier `e0dd5f6` diagnosis is an additional independent reference. All seven
variants produce the same 262,144-particle output:

`73bb4520b3586ff899dac168b76c9ec32a919522509058368a3d2c13c1807f34`

| Simulation variant | Mean GPU time, 10 samples |
| --- | ---: |
| Recorded original, 256 threads | 4.299 ms |
| Current constant-generated reference, 256 | 4.283 ms |
| Constant switch reference, 256 | 2.727 ms |
| Metadata direct indexing, 256 | **2.386 ms** |
| Current constant-generated reference, 64 | 3.700 ms |
| Constant switch reference, 64 | 2.394 ms |
| Metadata direct indexing, 64 | 2.366 ms |

Metadata with 256 threads reduces this captured pass by **44.5%** from the recorded
original. The additional 64-thread difference is below one percent, so production
retains 256. This is simulation time, not a whole-page FPS gain or a cross-GPU promise.

The secondary-display launcher found no qualifying non-main high-refresh display and
did not open a headed window. Successful replay uses headless Chrome with the real
Apple GPU; it does not establish 144 Hz hardware presentation. User browser windows
and the primary display were not controlled.

With prepared data and `npm run dev`, run:

```sh
node tests/browser/flow-field-metadata-replay.mjs
```

`FLOW_SAMPLER_NATIVE=1` requires verified secondary-display placement. Optional
`FLOW_SAMPLER_REFERENCE_SHADER` supplies a recorded complete shader for the same source;
it must pass the output check. Results go to ignored
`output/flow-field-metadata-replay/report.json`. The recorded shader's SHA-256 was
`9ff8dd85421e26e8e6d401ff5737efbd7ac4b5f02f7aa321fe08fe3fa4bd10bc`.

## Additional Query Evidence

The 32,768-query synthetic benchmark uses 52-bit positions and 64-thread groups.
Current constant versus metadata means were 0.183/0.149 ms fully resident,
0.107/0.114 ms mixed fallback, and 0.121/0.106 ms at transitions. Mixed fallback was
slightly slower. These are separate kernels and are not combined with the 40-bit
actual-frame replay into a universal gain. Reproduce with
`node tests/browser/flow-field-sampler-reuse.mjs --benchmark`.

## Integration

Normal startup, delayed style readiness and warm reload pass without page errors.
Trail-quality checks cover Balanced/Native, paused changes, inspection, resize and
new time pairs. DPR 2 stationary, pan, pitch, wheel and wheel-with-time handoff show
no stopped rendered frames, particle reset or history clears. Cleanup converges to
zero owned runtimes, active captures and Worker tasks. Inspector handoff retains the
previous image until the new pair is complete.

Resolution, particle count, full sampling and single-frame admission are preserved.
Anti-aliasing and frame pipelining remain separate work.

Final checks pass: documentation generation/translation/check, typecheck, production
build, and 1,809 Mocha tests (two existing opt-in gates pending). Native retained-history,
history-support and temporal-status proofs pass after their synthetic samplers adopt
the parameter-accessor interface. Real-page 30/60 Hz visual-time checks preserve exact
paused images and correct resume progression. Test-owned browsers and the shared
development process group were closed after verification.
