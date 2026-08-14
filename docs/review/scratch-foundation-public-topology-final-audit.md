# Scratch Foundation Public Topology Final Audit

## Completion

Status: confirmed-clean
Goal-start: `063b543a5e9616b791a4e1d87f65d0e42342209b`
Gate HEAD: `68f851df9278ea795922dc238f619b90ce989a6c`
Final commit: recorded by the completion report after this audit commit is created
Branch: `dev-feature`
Branch inventory: only local `dev-feature`, remote `origin/dev-feature`, and
`origin/HEAD -> origin/dev-feature`
Push status: not pushed; the gate HEAD was eight commits ahead of the remote

The fixed gate started from a clean worktree. The bounded review then corrected
two in-scope defects: incomplete internal GPU naming clean cut and mutable entries
accepted by the diagnostic report factory. It also removed one trailing whitespace
defect. No unresolved finding remains.

## Environment

| Fact | Observed value |
| --- | --- |
| Node.js | `v25.8.1` |
| npm | `11.11.0` |
| Browser used by all browser probes | Chrome `150.0.7871.188` |
| Adapter | Apple |
| Backend architecture | `metal-3` |
| Confirmed optional features | `shader-f16`, `subgroups`, `timestamp-query` |
| Representative limits | `maxBufferSize=4294967292`, `maxBindGroups=4`, `maxStorageBuffersPerShaderStage=10` |

The locally cached Playwright browser inventory also contained Chrome
`148.0.7778.96`; it was not the browser launched by the gates. Probe-emitted
browser facts above are authoritative for this audit.

## Fixed Gate

The full gate was executed exactly once, in this order:

```bash
npm run typecheck
npm test
npm run build
node tests/audits/scratch-webgpu-wgsl-current-coverage.mjs
node tests/browser/worker-system.mjs
node tests/browser/scratch-hello-gaw.mjs
node tests/browser/scratch-underwater-terrain.mjs
node tests/browser/scratch-flow-layer.mjs
```

| Gate | Result | Retained facts |
| --- | --- | --- |
| TypeScript typecheck | PASS | Package, examples, and the alternate WebGPU type surface compiled. |
| Full Mocha suite | PASS | No failing test. Fixed-history parity and declaration checks were included. |
| Production/example build | PASS | 166 Vite modules built. The existing chunk-size warning is informational. |
| WebGPU/WGSL current coverage | PASS | 1,244 entries: 1,242 managed and two not applicable; zero unresolved. |
| Worker browser | PASS | Priority/reprioritization, cooperative cancellation, transferable detachment, context affinity, crash recovery, and terminal zero task/group/context/worker ownership all passed. |
| Hello GAW browser | PASS | 240 proof frames, stable identity across resize, zero uncaptured errors, zero device loss, zero incidents, and no console/page/request/HTTP failure. |
| Underwater Terrain browser | PASS | Process exited successfully and produced nonempty initial, moved, and resized screenshots. The runner emitted no stdout, so this audit retains exit status and artifacts rather than inventing console facts. |
| Flow browser | PASS | 660 proof frames, 262,144 particles, camera reprojection and history clear, estuary boundary proof, expected structured failures, terminal zero pending work, zero uncaptured errors/device loss, and no console/page/request/HTTP failure. |

Underwater Terrain evidence retained at the gate follows. The `dem-*` artifact
filenames below are exact historical outputs from the 2026-08-05 gate, before
the example identity was renamed by ADR-075:

- `/tmp/geoscratch-underwater-terrain-browser/dem-initial.png`: 69,144 bytes
- `/tmp/geoscratch-underwater-terrain-browser/dem-moved.png`: 65,300 bytes
- `/tmp/geoscratch-underwater-terrain-browser/dem-resized.png`: 50,550 bytes
- Artifact timestamp: `2026-08-05T14:28:14+0800`

The Flow boundary proof used display extent
`[120.04373606134682, 31.173901952209487, 121.96623240116922, 32.08401085804678]`.
Its inside difference ratio was approximately `0.5746`; the outside ratio was
approximately `0.001467`.

## Manifest Reconciliation

The target audit passed with inventory hash
`08505999f55be63b0f92d04a0c049284fd2388040cacad37a4d293e59f367fc4`.
Every one of 1,173 baseline entries and 1,360 value/type facets has exactly one
disposition.

| Disposition | Baseline entries | Interpretation |
| --- | ---: | --- |
| Preserve | 162 | Same approved public concept remains. |
| Move | 629 | Same contract moved to its owned Scratch or Geo facade. |
| Rename | 202 | Same current contract has the clean-cut target name. |
| Remove | 180 | Explicitly retired legacy or duplicate surface. |
| Target additions | 12 | New namespace/diagnostic/type facts required by the accepted topology. |

There is no unclassified deletion. Removed legacy implementations are not counted
as preserved behavior. Every modern GPU behavior present at the goal start remains
owned by `packages/geoscratch/src/scratch/gpu/` and is covered by focused Scratch
tests, fixed-history parity, current WebGPU/WGSL coverage, and the three rendering
browser probes. Every Worker scheduling, cancellation, context, transfer, failure,
and reclamation behavior remains owned by
`packages/geoscratch/src/scratch/worker/` and is covered by Worker unit, deployment,
public-contract, and browser tests. Geometry byte parity and retained Geo behavior
have dedicated tests and DEM/Flow browser ownership.

## Bounded Review

| Review axis | Result | Evidence |
| --- | --- | --- |
| Correctness | PASS | Full gate passed; review corrections were bounded and directly retested. |
| Public-contract completeness | PASS | Root exports only `scratch` and `geo`; package exports contain only the four approved keys; exact runtime and type fixtures pass. |
| Architecture direction | PASS | Geo depends on public Scratch capability contracts; Scratch GPU and Worker have no forbidden reverse/cross-domain imports or shared runtime. |
| Accidental deletion | PASS | Machine inventory classifies every baseline facet; current examples import only approved facades. |
| TypeScript declarations | PASS | Production emit contains 75 JavaScript files and 75 matching declaration files from TypeScript-only source. |
| Diagnostic immutability | PASS | Envelopes, reports, errors, and copied library-owned nested facts are frozen; opaque caller facts remain opaque. |
| Worker semantic parity | PASS | Unit and real-browser coverage retains priority, aging, budgets, cancellation modes, isolation, contexts, transfer, failures, disposal, and reclamation. |
| Browser-visible regressions | PASS | Hello GAW, DEM, and Flow render and react to movement/resize with zero unexpected browser or WebGPU failure. |

The review corrections make `createScratchDiagnosticReport()` normalize every
caller-provided diagnostic into an immutable library-owned envelope before it is
retained, and rename the remaining GPU authority/diagnostics helpers from the
predecessor runtime word stem to the accepted GPU word stem. Focused diagnostics
tests pass with seven cases, source topology passes with four cases, fixed-history
parity passes with three cases and one opt-in acceptance case skipped, and the full
TypeScript check passes after the correction. Because these corrections only freeze
already-public report facts and mechanically rename internal identifiers, the
successful browser evidence is retained without restarting the full gate.

## Final Hygiene

Exact commands:

```bash
git diff --check 063b543..HEAD
git status --short
rg -n "geoscratch/(worker|geometry)" packages examples tests README.md README_zh.md
rg -n "ScratchRuntime|ScratchDiagnosticCapture|ScratchRenderPipeline|ScratchComputePipeline|WorkerDiagnosticError|createWorkerDiagnostic" packages examples tests README.md README_zh.md docs/vision docs/review
```

Results:

- Diff check: PASS after removing the one reviewed trailing space.
- Status: only the bounded Task 8 audit/correction files were present before commit.
- Removed-subpath search: only explicit negative contract tests matched.
- Predecessor-name search: every match is an exact path/symbol pair in the
  historical-name allowlist; the allowlist has no wildcard entries.

Goal 2 Persistent Cache and Goal 3 Geo cache/DEM adaptation were not started.

## Completion Record

```text
Status: confirmed-clean
Goal-start: 063b543a5e9616b791a4e1d87f65d0e42342209b
Final commit: recorded in the final completion report
Public exports: pass
GPU one-to-one parity: pass
Worker semantic parity: pass
Unified diagnostics: pass
TypeScript-only source: pass
WebGPU/WGSL audit: pass
Worker browser: pass
Hello GAW browser: pass
Underwater Terrain browser: pass
Flow browser: pass
Findings: none
```
