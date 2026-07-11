# Scratch GPU Operation Provenance Performance Evidence

Status: Complete
Date: 2026-07-11
Decision: ADR-032

## Result

The default bounded operation recorder adds a small absolute CPU cost in this
synthetic allocation benchmark, while stack capture is visibly more expensive.
The default profile therefore remains bounded and stack-free; deep capture
remains explicit and temporary.

The measurements do not justify a universal overhead percentage. Node uses an
in-process fake `GPUDevice`, and the Chrome measurements depend on one browser,
adapter, driver, machine, timer resolution, and workload.

## Reproduction

```bash
npm --workspace geoscratch run build
node --expose-gc tests/benchmarks/scratch-gpu-operation-provenance.mjs \
  > /tmp/geoscratch-gpu-operation-provenance-benchmark.json

npm run dev
node tests/browser/scratch-gpu-operation-provenance.mjs \
  > /tmp/geoscratch-gpu-operation-provenance-browser.json
```

The browser verifier writes regenerated screenshots under
`/tmp/geoscratch-gpu-operation-provenance-browser/`. Pixel variance was checked
with Pillow against those screenshots; it is supporting visual evidence rather
than an API requirement.

## Node CPU Evidence

Environment:

- Node `v25.8.1`
- macOS arm64
- Apple M1 Max, 10 logical CPUs
- 5 rounds
- 200 untimed warmup allocations per round
- 1000 measured allocations per ordinary profile
- 500 measured allocations per capture profile

Each operation creates and disposes a 4-byte public `BufferResource`. `issue`
ends after both native scope pops have been requested and before promise
settlement. `settlement` ends when the public allocation promise resolves. The
fake device settles scopes in-process, so this table excludes browser IPC,
driver work, physical GPU allocation, and queue work.

| Profile | Issue median us/op (range) | Settlement median us/op (range) | Total median us/op (range) | Retained evidence at end |
| --- | ---: | ---: | ---: | --- |
| History capacity zero | 4.915 (4.364-8.455) | 5.391 (4.707-11.221) | 10.588 (9.377-21.357) | 0 operations, 0 bytes |
| Default bounded recorder | 4.698 (3.631-5.386) | 7.174 (6.949-8.100) | 12.208 (11.734-13.864) | 256 operations, 150012 bytes |
| Steady-state overwrite, capacity 32 | 4.390 (3.580-5.935) | 6.966 (5.477-8.896) | 12.797 (9.264-13.577) | 32 operations, 18767 bytes |
| Capture with full descriptors | 3.476 (3.286-3.688) | 9.392 (7.554-10.314) | 13.082 (11.064-14.219) | 500 capture records, 306192 bytes |
| Capture with stacks and full descriptors | 16.031 (15.024-17.791) | 11.297 (9.401-12.635) | 28.127 (24.694-30.635) | 500 capture records, 924712 bytes |
| Capture without stacks | 3.664 (3.257-5.280) | 9.119 (6.715-11.127) | 14.537 (10.167-15.452) | 500 capture records, 292202 bytes |
| Capture with stacks | 15.408 (14.801-34.786) | 9.246 (8.556-10.547) | 24.880 (23.567-45.611) | 500 capture records, 910701 bytes |

`History capacity zero` disables retained operation and incident history. It
does not disable descriptor normalization, balanced error scopes, current fact
maintenance, operation IDs, completion classification, or fixed-size
aggregates. It is therefore the minimum correct path, not a return to
synchronous unchecked allocation.

The default total median was 1.620 us/op above the history-capacity-zero median
in this run. The ranges overlap, and this is not a portable percentage claim.
Stack capture increased both issue cost and retained serialized evidence in the
same environment, supporting its explicit opt-in policy.

## Long-Run Retention

One runtime performed 20000 successful create/dispose cycles with operation
capacity 64, incident capacity 8, and a 64 KiB serialized-evidence budget.

| Fact | After 10000 events | After 20000 events |
| --- | ---: | ---: |
| Retained operations | 64 | 64 |
| Retained incidents | 0 | 0 |
| Retained serialized evidence | 37533 bytes | 37663 bytes |
| Overwritten operations | 9936 | 19936 |
| Live resources | 0 | 0 |
| Pending operations | 0 | 0 |
| Lifecycle subscribers | 0 | 0 |

The retained count did not grow after capacity. The 130-byte serialized-size
difference comes from longer monotonic IDs in the retained records and remains
inside the configured budget; it is not linear retained history.

The configured serialized-evidence budget is not a heap guarantee. It bounds
retained JSON evidence, not JavaScript engine allocation or physical memory.

With explicit GC enabled, `process.memoryUsage().heapUsed` changed from 6854048
to 6793328 bytes between the two samples, a delta of -60720 bytes. This is
environment-specific supporting evidence only. A transient heap reading is not
used as the boundedness guarantee.

## Promise And Record Inventory

The source-level promise inventory for one successful initial public allocation
is 12 observable promise surfaces:

1. One public async runtime factory promise.
2. One async resource factory promise.
3. Two native `popErrorScope()` promises.
4. Two normalized scope-result promises returned by `popScope()`.
5. One `Promise.all()` scope aggregate and one tagged aggregate continuation.
6. One cancellable lifecycle notification promise.
7. One async settlement-function promise and one `Promise.race()` result.
8. One `finally()` result that unregisters lifecycle subscribers.

`TextureResource.resize()` has 11 source-level promise surfaces because it has
one public async method rather than separate runtime and resource factory
promises. ECMAScript engines may allocate additional internal reaction jobs or
promise objects; Scratch does not claim an exact engine heap-object count.

Exactly two promises are native WebGPU error-scope results. Both pops are issued
synchronously before the first `await`. Runtime and resource lifecycle
subscriptions are removed in `finally`; automated stress evidence proves their
subscriber counts return to zero after successful allocation and replacement.

The source-level logical record inventory is:

- Pending initial allocation: one pending operation fact and no live resource.
- Successful initial allocation: one compact bounded operation record and one
  current live resource fact; the detailed pending descriptor is released.
- Pending replacement: one pending operation fact plus the existing current
  resource fact linked to the pending replacement; the old allocation remains
  current.
- Successful replacement: one compact bounded operation record and the updated
  current resource fact.
- Active deep capture: one additional bounded capture record per accepted
  operation.
- Successful operation: zero incident records.
- Resource disposal: removes the current resource fact.

Nested immutable descriptor and subject values are implementation objects, so
this is a logical-record count rather than a JavaScript object-allocation claim.

## Chrome WebGPU Evidence

Environment:

- Google Chrome `150.0.7871.115`, headed
- Adapter vendor `apple`
- Adapter architecture `metal-3`
- `core-features-and-limits` present
- 8 warmup allocations and 64 measured public buffer allocations

| Browser allocation measure | Median | Range |
| --- | ---: | ---: |
| CPU issue | 0 ms | 0-0.100000 ms |
| Scope settlement through public promise | 0.100000 ms | 0-0.600000 ms |
| Total public allocation | 0.100000 ms | 0-0.600000 ms |

Chrome's timer resolution quantized several issue samples to zero. The probe
retained 72 successful bounded operation records including warmup, 0 incidents,
0 pending operations, 0 live resources, and 0 lifecycle subscribers. Default
records omitted stacks and full descriptors. Console warnings/errors and page
errors were both zero.

The `textureResize` proof separately measured its cold-path operations. In the
final desktop run, initial texture issue/settlement were 1.100000/1.899999 ms,
and replacement issue/settlement were 0.299999/4.700000 ms. Those are individual
samples, not benchmark distributions.

## Browser Regression Matrix

All required examples passed in the same headed Chrome run:

| Example | Machine status | Console warning/error | Page error | Request failure | Visual evidence |
| --- | --- | ---: | ---: | ---: | --- |
| `textureResize` desktop | `passed` | 0 | 0 | 0 | Nonblank; 124 sampled colors |
| `textureResize` mobile, 390x844 | `passed` | 0 | 0 | 0 | Nonblank; 130 sampled colors; no horizontal overflow |
| `submissionOrder` | `passed`, result 11 | 0 | 0 | 0 | Nonblank; 272 sampled colors |
| `externalImageUpload` | `passed` | 0 | 0 | 0 | Nonblank; 146 sampled colors |
| `readinessPolicies` | `ready` | 0 | 0 | 0 | Nonblank; 266 sampled colors |
| `indirectExecution` | `ready` | 0 | 0 | 0 | Nonblank; 314 sampled colors |
| `scratch_textureSampling` | `ready` | 0 | 0 | 0 | Nonblank; 115 sampled colors |
| `scratch_renderToTexture` | `ready` | 0 | 0 | 0 | Nonblank; 7900 sampled colors |

`textureResize` produced 21 true boolean proof facts, exact padded readback
bytes, two successful texture allocation-operation records, zero incidents,
zero pending operations, compact default evidence, and JSON round-trip-safe
`exportEvidence()` output.

## Timing Boundaries

- CPU issue cost ends after both scope pops are requested.
- Promise settlement latency includes the selected fake or browser scope
  acknowledgement path.
- Browser settlement can include browser/device-process work, but it is not a
  direct measure of physical allocation or driver residency.
- Allocation performs no queue submission.
- No allocation timing waits for `queue.onSubmittedWorkDone()`.
- Actual queue-work completion belongs to `SubmittedWork.done` and is not part of these allocation numbers.

## Decision

Keep the default compact bounded recorder enabled. Keep JavaScript stacks and
full descriptor retention behind finite deep capture. Keep per-submission and
per-command native scopes deferred: this allocation evidence does not measure
their hot-path cost and does not justify enabling them.
