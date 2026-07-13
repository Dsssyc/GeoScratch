# Scratch Submission Native Provenance Performance Evidence

Date: 2026-07-13
Decision: ADR-035
Status: Node stress and benchmark complete; headed Chrome evidence is recorded in a later checkpoint

## Reproduction

```bash
npm --workspace geoscratch run build
node tests/stress/scratch-submission-native-provenance.mjs \
  > /tmp/geoscratch-submission-native-stress.json
node tests/benchmarks/scratch-submission-native-provenance.mjs \
  > /tmp/geoscratch-submission-native-benchmark.json
```

Both scripts self-verify structural invariants before writing a successful JSON
report and exit non-zero on scope, owner, operation, evidence, cleanup, or
outcome drift. Benchmark timing values have no machine-specific pass threshold.

## Measurement Boundary

- Device: deterministic in-process fake `GPUDevice`.
- Machine: Apple M1 Max, 10 logical CPUs, arm64 macOS, Node `v25.8.1`.
- Recorder: 64 operations, 8 incidents, and 64 KiB serialized evidence.
- `issue`: public `SubmissionBuilder.submit()` call through synchronous return.
- `observation`: submit return through `SubmittedWork.nativeOutcome` resolution.
- `done after observation`: native outcome through strengthened `done` settlement.
- `total done`: submit call start through strengthened `done` settlement.
- Deferred profiles manually settle fake error-scope Promises after submit returns
  and fake queue completion after native outcome. They prove boundary ownership;
  they do not simulate a real driver delay distribution.
- Values exclude browser IPC, driver execution, physical GPU work, physical
  memory residency, and JavaScript garbage-collection guarantees.

## Long-Run Stress

The default run enforced 20,000 summary and 20,000 off submissions. Each
submission performed one queue-side buffer upload and awaited both public
completion boundaries. Fake call arrays were drained incrementally so the
stress harness itself did not retain a linear native-call log.

| Profile | Submissions | Elapsed | Scope pushes/pops | Queue writes | Retained recorder | Terminal facts |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Summary | 20,000 | 773.986 ms | 60,000 / 60,000 | 20,000 | 64 operations, 0 incidents, 55,446 bytes, 19,938 overwritten | 0 pending operations, observation owners, effectful works, resources, captures, subscribers, open scopes, or post-disposal listeners |
| Off | 20,000 | 563.497 ms | 0 / 0 | 20,000 | 64 operations, 0 incidents, 54,573 bytes, 19,938 overwritten | Same terminal zero; peak pending observations also remained 0 |

The elapsed values are one synthetic run and are not a portable percentage
claim. The structural result is the contract: summary uses exactly one
three-filter bundle per effectful submission regardless of work count; off uses
none while retaining explicit `unobserved` outcomes and bounded history.

Additional stress gates passed:

- A deferred owner at `maxPendingNativeObservations: 1` caused the next
  submission to fail with
  `SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED` before a second queue
  write. Reverse pop settlement returned pending observation, effectful work,
  subscriber, and scope counts to zero.
- One captured validation failure had both application-facing Promises ignored.
  It produced zero `unhandledRejection` events, marked the still-current epoch
  indeterminate, and a later acknowledged upload restored `ready` at epoch 2.
- One operation-limited detailed copy used 12 scope pushes and one balanced
  debug group. The capture stopped with `operation-limit`, retained one operation
  and 1,235 bytes, then the next copy returned to summary's 3 scopes and zero
  debug groups.
- Every profile remained below 64 KiB retained evidence and ended with zero
  lifecycle subscribers and zero application-visible resource ownership.

## Benchmark Matrix

Each row is the median of five structurally verified rounds with 50 untimed
warmups and 250 measured submissions. "Many" means eight commands or eight
queue actions. Values are microseconds per submission.

| Profile | Issue | Observation | Done after observation | Total done | Scopes/submission |
| --- | ---: | ---: | ---: | ---: | ---: |
| `effect-free-immediate` | 5.513 | 0.352 | 0.381 | 6.230 | 0 |
| `off-one-command-immediate` | 41.886 | 13.068 | 0.722 | 54.900 | 0 |
| `summary-one-command-immediate` | 43.749 | 12.875 | 0.500 | 57.149 | 3 |
| `summary-many-commands-immediate` | 95.982 | 12.457 | 0.513 | 108.020 | 3 |
| `summary-one-queue-action-immediate` | 23.924 | 11.627 | 0.408 | 35.939 | 3 |
| `summary-many-queue-actions-immediate` | 75.228 | 11.373 | 0.456 | 86.976 | 3 |
| `detailed-one-command-immediate` | 38.890 | 27.939 | 0.524 | 67.612 | 12 |
| `detailed-many-commands-immediate` | 97.773 | 50.234 | 0.519 | 149.404 | 33 |
| `summary-one-command-deferred-observation` | 34.657 | 11.426 | 0.419 | 46.727 | 3 |
| `summary-one-command-deferred-done` | 35.008 | 11.487 | 0.729 | 47.211 | 3 |
| `summary-one-command-deferred-observation-and-done` | 34.159 | 10.911 | 0.637 | 45.936 | 3 |

All 55 rounds verified:

- the exact expected scope, native command, queue action, queue submit, debug
  group, and completion-registration counts;
- only `no-native-work`, `unobserved`, or `observed-succeeded` as appropriate;
- zero unsettled scope/queue Promises, open scopes, pending operations,
  observation owners, effectful submitted work, live resources, active captures,
  lifecycle subscribers, incidents, and post-disposal listeners;
- default recorder counts and bytes within configured capacities;
- exactly 250 retained detailed-capture operations per detailed round, followed
  by an automatic `operation-limit` stop.

## Interpretation

The benchmark does not establish a ranking between off, summary, or detailed
mode. The profiles execute against an in-process fake device, and medians can
move with JIT state, timer resolution, CPU scheduling, and process load. No
timing threshold is enforced.

The evidence does support the architecture decision independently of timing:
default summary instrumentation is O(1) in scope count while detailed capture
is O(number of instrumented locations) and remains finite. Recorder memory is
bounded independently from current ownership, and all asynchronous ownership
returns to terminal zero.

## Headed Chrome

Real WebGPU valid submission, delayed validation, exact readback bytes, and the
11-page visual regression matrix are intentionally left to the headed Chrome
checkpoint. No browser or adapter claim is inferred from the Node results above.
