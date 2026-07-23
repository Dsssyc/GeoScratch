# Scratch Hello GAW Initialization Failure Evidence Audit

Status: ADR-050 static migration complete; migrated real-browser rerun pending Phase 6
Date: 2026-07-17
Fixed candidate baseline: `d8b277e90cb79cab6eaec48e23628f73f42f9ea3`
Feature branch: `socu/hello-gaw-init-failure-proof-v1`

ADR-050 update, 2026-07-24: Bloom compilation is now acknowledged by a
first-class ShaderModule before Program or Pipeline creation. The failure scenario,
capture boundary, and source-free evidence assertions below use that owner. Earlier
pipeline-owned browser measurements are historical and are not reused as current
evidence.

## Scope

This audit covers the one confirmed finding left by the Hello GAW clean-cut candidate:
partial asynchronous initialization did not yet have a page-level owner. It does not
review the Scratch core API, migrate the example to TypeScript, change the rendering
graph, or claim OOM/device-loss coverage.

The implementation uses only an example-local lifetime helper, test-only fault
configuration, browser proof publication, and documentation. Scratch resources remain
owned transitively by `ScratchRuntime`; decoded `ImageBitmap` values remain owned by
the page.

## Ownership And Settlement Contract

| Acquired state | Registration boundary | Owner | Terminal action | Evidence |
| --- | --- | --- | --- | --- |
| `ScratchRuntime` | Immediately after awaited creation | Page lifetime | `runtime.dispose()` once | Created, dispose-attempt, and public `isDisposed` facts |
| `Surface` | Immediately after synchronous creation | Runtime | Transitive runtime disposal | Created and public `isDisposed` facts |
| Decoded `ImageBitmap` | Immediately after each decode | Page lifetime | `close()` once | Created, close-attempt, closed, and duplicate-attempt counts |
| Initial `SubmittedWork` observation | Immediately after `submit()` | Page lifetime | Await terminal settlement | Pending before/after counts |
| Frame observations | Immediately after each frame submit | Page lifetime | Await terminal settlement | Same pending registry |
| Device/page listeners | At installation | Page lifetime stop phase | Remove listener | Installed/removed/active counts |
| Timer/animation frame | At scheduling | Page lifetime stop phase | Cancel outstanding work | Scheduled/completed/cancelled/active counts |

Disposal runs stop, settle, and release phases in that order. Actions within stop and
release are LIFO. The authority memoizes one disposal Promise, retains the first
primary failure, continues after action failures, and clears action and observation
collections before reporting terminal state.

## Deterministic Browser Matrix

The managed headed-Chrome verifier ran every scenario in a fresh BrowserContext on
Chrome `150.0.7871.125` with an Apple Metal 3 adapter. The table records the observed
facts from the passing run; generated identities and timing values are intentionally
not treated as constants.

| Scenario | Runtime / Surface disposed | Bitmaps created / closed | Pending before / after | Cleanup actions | Scratch incidents |
| --- | --- | ---: | ---: | ---: | ---: |
| `after-runtime-created` | yes / not created | 0 / 0 | 0 / 0 | 1 | 0 |
| `after-first-image-decoded` | yes / yes | 1 / 1 | 0 / 0 | 2 | 0 |
| `invalid-bloom-shader-wgsl` | yes / yes | 8 / 8 | 0 / 0 | 9 | 1 |
| `after-graph-created` | yes / yes | 8 / 8 | 0 / 0 | 9 | 0 |
| `after-initial-submit-issued` | yes / yes | 8 / 8 | 1 / 0 | 9 | 0 |

Every scenario reached its target once, invoked physical cleanup once, retained zero
cleanup actions, recorded zero duplicate bitmap closes, and had zero cleanup failures.
The initial-submission scenario independently records pending `1 -> 0` before runtime
disposal.
No scenario installed a listener or scheduled frame work because every fault boundary
precedes steady-state rendering. Those explicit zero counts are expected facts, not
claims that a nonexistent listener or frame was removed.

The verifier rejects missing/vacuous acquisition counts, a live runtime or Surface,
bitmap count mismatch, duplicate closure, pending observations, retained actions,
cleanup failures, page errors, request failures, HTTP failures, missing expected
console reporting, and a still-open Vite port. After proof publication, each page stays
open for a fixed 250 ms quiet interval before the final unhandled-rejection snapshot.

## Source-Blind Failure Localization

The invalid mode appends malformed text only to the in-memory Bloom-combine
ShaderModule source part. The checked-in WGSL file is unchanged. One capture starts
immediately before ShaderModule acknowledgement with these hard bounds:

- maximum operations: 1;
- maximum duration: 2,000 ms;
- maximum evidence bytes: 65,536;
- stacks and bounded descriptors enabled only inside that finite capture.

The migrated verifier requires `operation-limit`, one failed
`shader-module-creation` operation, zero omitted operations, and finite evidence under
the configured bounds. The exact incident retains one bounded compilation report with
one source-part fact and source-part-relative message locations. Updated numeric
browser evidence is recorded only after the Phase 6 headed rerun.

The source-blind localization bundle exposes these structural links:

| Required question | Machine-readable fact |
| --- | --- |
| Which operation failed? | Capture operation kind and failed status |
| Which ShaderModule? | `target.shaderModuleId` and matching compilation `shaderModuleId` |
| Which source part? | One source-part fact with hash plus message `sourcePartIndex: 0` |
| Which failure family? | Incident outcome `SCRATCH_SHADER_MODULE_COMPILATION_FAILED` |
| Which stage? | Matching incident outcome stage `shader-compilation` |
| Is the top-level error exact? | `SCRATCH_SHADER_MODULE_COMPILATION_FAILED` on the supporting-object incident |
| Is source retained? | No WGSL source; source-part hashes, bounded locations, and sanitized messages only |

The compilation outcome and report are sufficient to direct repair to the
Bloom-combine ShaderModule source part without source access or console parsing.
Pipeline creation is never started for an unacknowledged module, so no pipeline
identity or pipeline failure is fabricated.

## Runtime Evidence Bounds

Each proof exports diagnostics before runtime disposal. The runtime uses a 256
operation capacity, 32 incident capacity, and 262,144 evidence-byte capacity. The
invalid-pipeline runs retained less than 148,000 recorder evidence bytes with 113
operations and one incident; the graph-boundary proofs retained at most 140 operations.
All remain within the configured bounds. The proof independently publishes and checks
the UTF-8 JSON byte length of `runtimeEvidence` against a 524,288-byte outer limit; the
observed complete payloads remained below 198,000 bytes. The final Agent-facing payload
is therefore bounded in addition to the recorder. The proof object is recursively
frozen after a JSON round trip and contains no mutable GPU handles.

Default runtime evidence remains the bounded ledger defined by Scratch. Deep stacks
and descriptors are enabled only for the one-operation invalid-pipeline capture; the
other four scenarios contain no capture report. The browser verifier owns independent
fixed constants for the runtime recorder, outer JSON, capture operation/duration/byte,
and compilation-byte ceilings; it rejects a producer that weakens or self-certifies
those limits.

## Success-Path Preservation

Fault configuration is immutable, query-only, and inactive when no supported fault is
selected. Bitmap ownership is released after the original initial-submission
observation succeeds. The normal path retains the exact five stages, 45 Hz scheduling,
five scene commands, 17 Bloom commands, GPU-only indirect arguments, resize behavior,
and stable command/resource identities established by ADR-042.

Shader and image byte preservation is checked independently against fixed candidate
`d8b277e90cb79cab6eaec48e23628f73f42f9ea3`. The existing 240-frame headed browser
verifier remains the success regression authority.

## Claim Boundary

This proof closes page-owned initialization cleanup and demonstrates one real pipeline
compilation failure family. It does not prove physical VRAM reclamation timing, OOM
attribution, device-loss recovery, arbitrary browser teardown, or a generic lifecycle
abstraction for other examples. Any such claim requires a separate Goal and evidence.
