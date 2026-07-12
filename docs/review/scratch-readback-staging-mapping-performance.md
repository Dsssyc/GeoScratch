# Scratch Readback Staging And Mapping Performance

Date: 2026-07-12
Status: Reproduced on the feature branch

## Reproduction

```bash
npm run build
node tests/stress/scratch-readback-staging-mapping.mjs
node tests/benchmarks/scratch-readback-staging-mapping.mjs
npm --workspace examples run dev -- --host 127.0.0.1 --port 4173
node tests/browser/scratch-readback-staging-mapping.mjs
```

The browser verifier intentionally uses the Vite development server because its
probe imports built package modules through `/@fs`. The standalone example build
is still a separate required gate.

## Measurement Boundary

- Node benchmark device: deterministic in-process fake `GPUDevice`.
- Machine: Apple M1 Max, 10 logical CPUs, arm64 macOS, Node v25.8.1.
- Each benchmark profile: 50 warmup iterations, 250 measured iterations, 5 rounds.
- Issue time ends when the public call returns its Promise or synchronous
  `SubmittedWork`; settlement ends at acknowledged allocation or owned host
  bytes.
- Deep capture is explicit, finite, source/byte-free, and includes stacks and
  full bounded descriptors.
- Values exclude browser IPC, real driver allocation/mapping latency, physical
  GPU work, and physical memory residency.
- No machine-specific time threshold is a pass condition. Structural retention,
  cleanup, operation count, and boundary drift are failing gates.

## Benchmark Medians

All values are microseconds per iteration. Timing noise means rows must not be
treated as a ranking; their purpose is to expose separate cost boundaries.

| Profile | Issue | Settlement | Total | Recorder evidence |
| --- | ---: | ---: | ---: | --- |
| `direct-mapping-history-disabled` | 26.10 | 72.58 | 98.68 | 0 retained operations; 901 omitted records |
| `direct-mapping-default-recorder` | 26.08 | 92.80 | 120.71 | 256 retained; 175,184 bytes; 645 overwritten |
| `direct-mapping-deep-capture` | 82.57 | 245.96 | 334.66 | default history 0; capture structurally verified |
| `ordered-factory-history-disabled` | 13.17 | 24.60 | 45.14 | acknowledgement only; disposal excluded from timing |
| `ordered-mapping-history-disabled` | 107.76 | 59.72 | 167.48 | one persistent slot; 603 omitted records |
| `ordered-mapping-default-recorder` | 76.76 | 72.93 | 147.14 | 256 retained; 221,886 bytes; 347 overwritten |
| `submission-no-readback-history-disabled` | 8.72 | 0.38 | 9.15 | effect-free synchronous baseline |

Every round ended with zero pending GPU operations, current readbacks, current
commands, staging bytes, retained host bytes, active mappings, and lifecycle
subscribers after profile cleanup. History-disabled profiles retained zero
operations. Deep-capture rounds retained readback operations with stacks and
full descriptors, then stopped explicitly.

## Long-Run Stress

The stress runner uses a 64-operation, 8-incident, 64 KiB recorder to force
steady overwrite.

| Workload | Native facts | Elapsed | Terminal facts |
| --- | --- | ---: | --- |
| 20,000 direct operations | 20,000 staging allocations, 20,000 maps, 20,000 destroys | 2,466.85 ms | 0 pending/readbacks/commands/staging/host/mappings/subscribers; 59,937 overwritten operations |
| 5,000 ordered reuses | 1 acknowledged staging allocation, 5,000 maps, 0 reuse-time allocations, 1 destroy at command disposal | 711.45 ms | 0 pending/readbacks/commands/staging/host/mappings/subscribers; 9,939 overwritten operations |

The ordered pre-disposal snapshot intentionally retained one idle command and
16 logical staging bytes. Disposal removed both exactly once. Logical staging
bytes are not a claim about native physical residency.

## Headed Chrome

- Chrome 150.0.7871.115, headed mode, `--enable-unsafe-webgpu`.
- Adapter: Apple, Metal 3.
- Ordered and direct paths both returned exact `Uint32Array` values
  `[2, 4, 6, 8]`.
- Ordered factory returned a Promise and exposed no command fact before
  acknowledgement; `submit()` synchronously returned a non-thenable
  `SubmittedWork` in 1.60 ms for this sample.
- One frozen serializable readback link was retained. Evidence was schema v3,
  JSON round-trippable, and contained successful allocation, mapping, and
  release operations for both paths.
- Success probe produced zero incidents, uncaptured GPU errors, console
  warning/errors, page errors, and request failures.
- An 8-byte staging budget rejected a 16-byte direct readback with
  `SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED` at stage `budget`, then retained
  zero current ownership.
- The 11-page regression matrix passed. Every page had a non-empty canvas with
  at least 5 quantized sampled colors and luminance range above 87, no viewport
  overflow, and no console/page/request failure.
- Screenshots were written to `/tmp/geoscratch-readback-browser`; they are
  verification output and are not repository assets.

## Interpretation Limits

- Fake-GPU timings measure Scratch CPU structure, not hardware performance.
- The headed result proves one real adapter/browser run, not all WebGPU
  implementations.
- Captured validation/internal/OOM errors are exact to the scoped operation
  boundary; OOM does not prove that the triggering allocation alone exhausted
  memory.
- Queue-completion rejection encloses all replayed work in that submission and
  cannot identify one command without narrower native evidence.
- Device loss near a mapping is temporal correlation unless a narrower error
  scope also reports an exact operation outcome.
