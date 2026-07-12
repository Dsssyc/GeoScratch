# Scratch Async Pipeline Creation Performance Evidence

Status: Complete
Date: 2026-07-12
Decision: ADR-033

## Result

Pipeline creation is initialization work with an explicit asynchronous native
acknowledgement boundary. The default recorder remains bounded and stack-free;
full descriptors and stacks remain limited to finite deep capture. Source and
benchmark inspection confirm that command construction and submission gained
no pipeline creation, compilation query, error scope, operation record, or
hidden wait.

These measurements support no universal overhead percentage. The Node profiles
use an in-process fake device, while browser timings depend on Chrome, the
adapter, driver, timer resolution, shader, and cache state. Cold/warm labels are
explicitly cache-dependent observations, not portable performance promises.

## Reproduction

```bash
npm --workspace geoscratch run build
node --expose-gc tests/benchmarks/scratch-async-pipeline-creation.mjs \
  > /tmp/geoscratch-async-pipeline-benchmark.json

npm --workspace examples run dev -- --host 127.0.0.1 --port 4173 --strictPort
node tests/browser/scratch-async-pipeline-creation.mjs \
  > /tmp/geoscratch-async-pipeline-browser.json
```

Both scripts verify structural facts before emitting JSON and exit non-zero on
failure. Timing values have no machine-specific pass threshold. Browser
screenshots are regenerated under `/tmp/geoscratch-async-pipeline-browser/`.

## Node Measurement Boundary

Environment:

- Node `v25.8.1`
- macOS arm64
- Apple M1 Max, 10 logical CPUs
- 5 rounds per profile
- 40 untimed warmup pipelines per round
- 200 measured pipelines per round
- 50 profile rounds passed self-verification

`CPU issue` ends when the public factory has issued the shader module,
pipeline layout, compilation query, one async pipeline request, and all three
scope-pop requests. `async settlement` begins when the factory returns and ends
when compilation, pipeline, scope, and lifecycle outcomes produce the ready
wrapper. `total` covers both. Pipeline disposal is excluded from timing but is
included in retention verification.

The fake device excludes browser IPC, driver compilation, physical GPU work,
and queue submission. Populated reports contain one synthetic warning and one
synthetic information message; empty reports contain no native messages. A
report builds its Program-source redaction index at most once and only when it
retains at least one native message. The index uses an adaptive Bloom workspace
with a hard 32-KiB ceiling, independent of complete Program source size; a
large-source regression test verifies the ceiling and exact-excerpt removal.
A separate WGSL lexical matrix covers short Unicode/non-BMP identifiers and
every decimal/hexadecimal integer and float form that cannot rely on the
eight-unit span fallback.

| Profile | CPU issue median us (range) | Async settlement median us (range) | Total median us (range) | Retained evidence at end |
| --- | ---: | ---: | ---: | --- |
| Render, empty, history zero | 14.963 (13.518-22.365) | 40.670 (37.356-51.944) | 55.634 (50.874-74.309) | 0 operations, 0 bytes |
| Render, populated, history zero | 14.013 (11.870-14.918) | 62.850 (57.993-67.291) | 76.240 (69.863-82.209) | 0 operations, 0 bytes |
| Compute, empty, history zero | 12.250 (10.204-12.585) | 36.455 (34.043-37.903) | 48.943 (44.247-50.153) | 0 operations, 0 bytes |
| Compute, populated, history zero | 9.286 (8.834-9.928) | 53.394 (52.765-54.172) | 62.608 (62.051-63.553) | 0 operations, 0 bytes |
| Render, empty, default recorder | 13.312 (11.375-13.630) | 40.975 (38.712-42.477) | 53.278 (52.024-56.107) | 205 operations, 260259 bytes |
| Compute, empty, default recorder | 9.048 (8.792-11.663) | 37.813 (36.839-41.459) | 49.476 (45.632-52.480) | 211 operations, 260770 bytes |
| Render, empty, steady overwrite | 11.375 (11.082-13.145) | 39.985 (38.698-42.293) | 51.322 (50.073-55.437) | 25 operations, 31157 bytes |
| Compute, empty, steady overwrite | 8.809 (8.443-9.523) | 38.028 (36.663-46.440) | 46.562 (45.106-55.963) | 26 operations, 32214 bytes |
| Render, populated, deep capture | 33.018 (32.706-34.242) | 92.534 (90.500-95.331) | 125.314 (123.207-128.349) | 400 capture operations, 1236990 bytes |
| Compute, populated, deep capture | 26.702 (26.205-29.520) | 84.555 (78.902-91.961) | 112.366 (105.141-121.481) | 400 capture operations, 1206853 bytes |

Capacity zero disables retained operation and incident history. It does not
disable IDs, descriptor hashing, scopes, compilation normalization, current
facts, lifecycle checks, or aggregates. Deep capture retained stacks on all 400
creation/disposal events and full descriptors on the 200 creation events;
disposal has no full pipeline descriptor to invent.

## Long-Run Boundedness

One runtime performed 5000 alternating render/compute create-dispose cycles
with operation capacity 64, incident capacity 8, and a 64 KiB serialized
evidence budget.

| Fact | After 2500 cycles | After 5000 cycles |
| --- | ---: | ---: |
| Retained operations | 55 | 55 |
| Retained incidents | 0 | 0 |
| Retained serialized evidence | 65403 bytes | 65411 bytes |
| Overwritten operations | 4945 | 9945 |
| Pending operations | 0 | 0 |
| Current pipeline facts | 0 | 0 |
| Runtime-owned pipeline wrappers | 0 | 0 |
| Lifecycle subscribers | 0 | 0 |

Retained operation count growth after the first half was zero. The 8-byte
size difference comes from variable IDs/timestamps in two bounded windows; it
is not linear history growth. The byte capacity bounds serialized evidence,
not engine heap or GPU memory.

With explicit GC, `heapUsed` changed from 6768328 to 6690808 bytes. This
-77520-byte sample is environment-specific supporting evidence only and is not
a heap guarantee.

## Chrome WebGPU Evidence

Environment:

- Google Chrome `150.0.7871.115`, headed
- Adapter vendor `apple`
- Adapter architecture `metal-3`
- `core-features-and-limits` present

| Cache-dependent sample | CPU issue ms | Async settlement ms | Total ms | Compilation messages |
| --- | ---: | ---: | ---: | ---: |
| Render cold | 0.300000 | 1.600000 | 1.900000 | 0 |
| Render warm | 0.200000 | 0.500000 | 0.700000 | 0 |
| Compute cold | 0.400000 | 1.500000 | 1.900000 | 0 |
| Compute warm | 0.100000 | 0.300000 | 0.400000 | 0 |

These are individual cache-dependent samples. They are not distributions and
do not establish a cold/warm ratio. The same verifier also measured a populated
invalid-WGSL report with one native error message and one retained error. It
asserted structural codes and counts only, never native message prose.

The browser transaction probe completed four valid pipelines and two expected
failures. It retained 10 operations and 2 incidents, then ended with zero
pending operations, current pipeline facts, runtime pipeline wrappers,
lifecycle subscribers, uncaptured WebGPU errors, console warnings/errors, page
errors, and request failures. For that run, exported evidence contained neither
the invalid Program source nor its sentinel and remained JSON-round-trip safe;
the implementation-level guarantee is separately enforced by source-echo unit
tests and `sourceExcerptRedacted`.

## Browser Regression Matrix

All required examples passed in the same headed run. Every canvas had at least
two quantized sampled colors and a luminance range above 4.

| Example | Machine result | Quantized colors | Luminance range |
| --- | --- | ---: | ---: |
| `scratch_helloTriangle` | passed | 18 | 136.4306 |
| `scratch_helloVertexBuffer` | passed | 319 | 160.6336 |
| `scratch_uniformTriangle` | passed | 18 | 87.1344 |
| `scratch_computeReadback` | `2, 4, 6, 8` | 27 | 183.9888 |
| `scratch_textureSampling` | ready | 23 | 190.6756 |
| `scratch_renderToTexture` | ready | 644 | 203.6676 |
| `indirectExecution` | ready | 36 | 139.2180 |
| `readinessPolicies` | ready | 43 | 166.2060 |
| `submissionOrder` | passed | 39 | 184.2014 |
| `externalImageUpload` | passed | 13 | 227.4446 |
| `textureResize` | passed | 5 | 129.6888 |

All 11 pages reported zero console warnings/errors, page errors, and request
failures. The `textureResize` proof was updated to query schema-v2 resource
targets explicitly rather than reading removed version-1 top-level fields.

## Decision

Keep pipeline creation asynchronous and outside submission. Keep the compact
bounded recorder enabled by default. Keep full descriptors and stacks behind
finite deep capture. Do not infer portable performance percentages or cache
behavior from these measurements.
