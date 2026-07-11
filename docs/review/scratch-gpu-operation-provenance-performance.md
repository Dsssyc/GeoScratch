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

npm --workspace examples run dev -- --host 127.0.0.1 --port 4173 --strictPort
node tests/browser/scratch-gpu-operation-provenance.mjs \
  > /tmp/geoscratch-gpu-operation-provenance-browser.json
```

The browser verifier writes regenerated page and canvas screenshots under
`/tmp/geoscratch-gpu-operation-provenance-browser/`. Status, diagnostic-probe
facts, console/page/request failures, and canvas pixel variance are executable
failure gates. The screenshots remain reviewable supporting evidence.

The Node benchmark verifies structural facts before printing its JSON and exits non-zero
on a failed capacity, operation-count, failure-count, capture-stop, or
lifecycle invariant. Its `verification` result records how many profile rounds
were checked. Timing values remain measurements: the script deliberately does
not enforce machine-dependent timing thresholds. `--strictPort` makes the Vite
command fail instead of silently moving the browser verifier to another port.

## Node CPU Evidence

Environment:

- Node `v25.8.1`
- macOS arm64
- Apple M1 Max, 10 logical CPUs
- 5 rounds
- 200 untimed warmup allocations per round
- 1000 measured allocations per ordinary profile
- 500 measured allocations per capture profile
- 35 profile rounds passed structural self-verification

Each measured allocation cycle creates and disposes a 4-byte public
`BufferResource`. `issue`
ends after both native scope pops have been requested and before promise
settlement. `settlement` and `total` end when the public allocation promise
resolves; subsequent disposal is excluded from allocation timing even though its
compact churn record participates in recorder retention. The
fake device settles scopes in-process, so this table excludes browser IPC,
driver work, physical GPU allocation, and queue work.

| Profile | Issue median us/allocation (range) | Settlement median us/allocation (range) | Total median us/allocation (range) | Retained evidence at end |
| --- | ---: | ---: | ---: | --- |
| History capacity zero | 3.892 (3.234-7.368) | 6.613 (4.858-10.041) | 11.001 (8.092-15.172) | 0 operations, 0 bytes |
| Default bounded recorder | 3.444 (2.885-4.142) | 7.134 (6.813-9.054) | 10.258 (10.219-12.770) | 256 operations, 140130 bytes |
| Steady-state overwrite, capacity 32 | 3.164 (2.916-3.650) | 8.058 (7.007-8.781) | 10.974 (10.204-12.432) | 32 operations, 17519 bytes |
| Capture with full descriptors | 4.591 (4.013-7.179) | 8.093 (7.582-10.451) | 14.458 (11.595-16.456) | 1000 capture records, 560216 bytes |
| Capture with stacks and full descriptors | 17.608 (17.002-20.250) | 13.587 (10.223-14.523) | 32.131 (27.225-33.507) | 1000 capture records, 1987692 bytes |
| Capture without stacks | 2.744 (2.657-3.140) | 7.441 (6.843-9.712) | 10.184 (9.524-12.369) | 1000 capture records, 546212 bytes |
| Capture with stacks | 16.036 (15.612-30.197) | 12.337 (9.640-15.588) | 28.287 (25.285-45.785) | 1000 capture records, 1973684 bytes |

`History capacity zero` disables retained operation and incident history. It
does not disable descriptor normalization, balanced error scopes, current fact
maintenance, operation IDs, completion classification, or fixed-size
aggregates. It is therefore the minimum correct path, not a return to
synchronous unchecked allocation.

The default total median was 0.743 us/allocation below the history-capacity-zero median
in this run. The ranges overlap. This is not a speedup claim and not a portable percentage claim.
Stack capture increased both issue cost and retained serialized evidence in the
same environment, supporting its explicit opt-in policy.

## Long-Run Retention

One runtime performed 20000 successful create/dispose cycles with operation
capacity 64, incident capacity 8, and a 64 KiB serialized-evidence budget.

| Fact | After 10000 allocation cycles (20000 operation events) | After 20000 allocation cycles (40000 operation events) |
| --- | ---: | ---: |
| Retained operations | 64 | 64 |
| Retained incidents | 0 | 0 |
| Retained serialized evidence | 35170 bytes | 35290 bytes |
| Overwritten operations | 19936 | 39936 |
| Live resources | 0 | 0 |
| Pending operations | 0 | 0 |
| Lifecycle subscribers | 0 | 0 |

The retained count did not grow after capacity. Serialized timestamps and
generated IDs vary between the two retained windows, so the 120-byte
serialized-size difference is expected bounded variation rather than linear
retained history. The evidence remains inside the configured budget.

The configured serialized-evidence budget is not a heap guarantee. It bounds
retained JSON evidence, not JavaScript engine allocation or physical memory.

With explicit GC enabled, `process.memoryUsage().heapUsed` changed from 6963784
to 6905336 bytes between the two samples, a delta of -58448 bytes. This is
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
  current live resource fact; default pending state never clones the full
  descriptor, while an active bounded capture may retain it.
- Pending replacement: one pending operation fact plus the existing current
  resource fact linked to the pending replacement; the old allocation remains
  current.
- Successful replacement: one compact bounded operation record and the updated
  current resource fact.
- Active deep capture: one additional bounded capture record per accepted
  operation.
- Successful operation: zero incident records.
- Resource disposal: one compact bounded `resource-disposal` record and removal
  of the current resource fact; allocation aggregates are unchanged.

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
| CPU issue | 0 ms | 0-0.200000 ms |
| Scope settlement through public promise | 0.200000 ms | 0-1.400000 ms |
| Total public allocation | 0.200000 ms | 0-1.500000 ms |

Chrome's timer resolution quantized several issue samples to zero. The probe
retained 144 successful bounded operation records including warmup: 72 buffer
allocations and 72 resource disposals. It retained 0 incidents, 0 pending
operations, 0 live resources, and 0 lifecycle subscribers. Default records
omitted stacks and full descriptors; retained serialized evidence was 79757
bytes. Console warnings/errors, page errors, and request failures were all zero,
and each fact was an executable verifier gate.

The `textureResize` proof separately measured its cold-path operations. In the
final desktop run, initial texture issue/settlement were 1.000000/1.700000 ms,
and replacement issue/settlement were 0.200000/4.900000 ms. Those are individual
samples, not benchmark distributions.

## Browser Regression Matrix

All required examples passed in the same headed Chrome run:

| Example | Machine status | Console warning/error | Page error | Request failure | Visual evidence |
| --- | --- | ---: | ---: | ---: | --- |
| `textureResize` desktop | `passed` | 0 | 0 | 0 | Gated nonblank; 5 quantized colors; 129.6888 luminance range |
| `textureResize` mobile, 390x844 | `passed` | 0 | 0 | 0 | Gated nonblank; 7 colors; 129.6888 range; no horizontal overflow |
| `submissionOrder` | `passed`, result 11 | 0 | 0 | 0 | Gated nonblank; 39 colors; 184.2014 range |
| `externalImageUpload` | `passed` | 0 | 0 | 0 | Gated nonblank; 13 colors; 227.4446 range |
| `readinessPolicies` | `ready` | 0 | 0 | 0 | Gated nonblank; 43 colors; 166.2060 range |
| `indirectExecution` | `ready` | 0 | 0 | 0 | Gated nonblank; 36 colors; 139.2180 range |
| `scratch_textureSampling` | `ready` | 0 | 0 | 0 | Gated nonblank; 23 colors; 190.6756 range |
| `scratch_renderToTexture` | `ready` | 0 | 0 | 0 | Gated nonblank; 644 colors; 203.6676 range |

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
