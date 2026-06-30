# Design Review

Status: Review (vision draft)
Date: 2026-06-30

## Scope

This module records the review that originally tested `00`–`05` against two lenses and motivated the later `07` addition:

1. **AI-assisted authoring** ("vibe coding"): does the design still fit when most code that uses it is written with AI help?
2. **General-purpose compute parity**: `scratch`'s goal, like WebGPU's, is a CPU-side mapping of GPU capability — so compute must be a co-equal first-class use, not a graphics adjunct. Does the design support serious high-performance parallel compute?

Conclusion: not a rewrite. The substance of `00`–`05` (explicit, declarative, validated, fail-fast) is already well-aligned. What needs change is the *primary objective's wording*, three targeted authoring points (Part 1), and **raising compute from an adjunct to a first-class use** (Part 2).

Status: Part 1 (Revisions A/B/C), Gap 1 (positioning), and Gap 5 (compute validation + dynamic offsets) are **applied** to `00`–`05` and `scratch-graphics-kernel.md`. Gaps 2–4 (async readback, submission unit, GPU timing/queries) are now **designed** across `05-passes-submissions-scheduler` and `07-transfers-epochs`. This module is the review record; `00`–`05` and `07` are the source of truth for what is applied. Ongoing open review items live under `docs/review/`.

## Part 1 — AI-Era Authoring Lens

### Evaluation Lens (correction)

An earlier framing judged the API by "is it easy for an AI to read" and "clever vs boring." Both are the wrong axis.

- "Clever vs boring" is a trap. The limit of "boring" is raw WebGPU, which is the *least* verifiable surface, not the most: its validity rules are implicit, and many logic errors (wrong allocation version, wrong content epoch, read-before-write, stale bind group after resize) fail silently with a wrong picture instead of an error.
- The correct axis is **abstraction that adds constraints + checks** vs **abstraction that adds hidden behavior**. The first can be *more* abstract than raw WebGPU and *more* verifiable at the same time. The second makes the same code behave differently depending on state you cannot see at the call site.

Every revision below is judged by two questions, in this order:

1. Functional: does it still express the real workload, including genuine runtime dynamism?
2. Verifiability: can correctness be confirmed by local reading, and can the system catch the error?

This lens — pragmatic function first, then verifiability-as-constraint — replaces "AI readability" and "clever vs boring" as the standard for the revisions.

### Revision A — Primary objective

Replace the boilerplate-reduction objective.

Earlier (`00-overview`, before Revision A):

> The new `scratch` API should reduce WebGPU boilerplate while preserving direct GPU control.

Problem: in the AI era the marginal cost of generating boilerplate is near zero, so "less code" is the least valuable thing an abstraction can offer. Verbosity is not the enemy; ambiguity and hidden/non-local state are.

Proposed objective:

> The new `scratch` API should maximize locally-verifiable correctness while preserving direct GPU control. It should add the constraints and checks that raw WebGPU lacks, without adding hidden behavior. Boilerplate that an author writes and a validator checks is acceptable; ambiguity and invisible state are not.

Consequences:

- Keep the "verbose" features — declared resource access, explicit transfer operations, explicit `BindLayout`, explicit submission order. They are the most future-proof part of the design. Do not auto-infer them merely for brevity.
- Every "smart" feature (allocation versioning, content epochs, readiness, device-loss rehydration) must expose inspectable and assertable state, such as readable `allocationVersion` / `contentEpoch` / `state` (`02-resources` already defines `ResourceState`). A smart feature that hides *why* a rebuild happened is net-negative.
- This does not weaken the existing escape-hatch requirement. Direct low-level control stays.

### Revision B — Closure policy

Generalize the existing "do not make command counts closures by default" (`04-pipelines-commands`) into a triage by *what the closure encodes*, instead of blanket avoidance. A closure is sometimes the honest cost of real dynamism — a draw count known only after runtime culling — not author convenience.

Triage:

1. **Static value, available at construction time** → no closure. Examples to remove: `range: () => [3]`, and `codeFunc: () => shaderCode` when the code is constant.
   - Exception: if the thunk exists to defer until device-ready, or to allow the value to change later, it is encoding *lifecycle/timing*, which is legitimate — but express that through the resource/ref model, not an ad-hoc closure.
2. **CPU-dynamic value** (count known only after CPU-side work such as culling) → closure is legitimate. Keep it as an explicit escape hatch.
3. **GPU-dynamic value** (count produced on GPU, e.g. GPU culling writes draw arguments) → prefer `indirect`, already named the preferred GPU-driven path in `04-pipelines-commands`. Strictly better than a CPU closure: no readback, fully declarative, visible to validation.

Verifiability ladder for dynamic counts (prefer the top):

```text
indirect buffer  >  ref / handle  >  closure
```

Bridge to the existing idiom: the project already has a non-closure dynamic primitive — `aRef` / `ArrayRef` (stable identity, mutable contents, dirty-trackable). Extend this handle model to counts (a count that reads from a ref or buffer) where the value is not GPU-produced. It is more verifiable than a closure and consistent with the existing design language.

Net rule: static → no thunk; CPU-dynamic → closure ok; GPU-dynamic → indirect.

### Revision C — Shader reflection as an opt-in, warn-level cross-check

Keep explicit `BindLayout` as the source of truth (`03-bindings`, "explicit is the contract"). Promote reflection from "scaffolding helper" to a *guard* for the single highest-frequency AI error: bind layout vs shader mismatch (binding index, type, visibility).

Constrain it so it never regresses function:

- **Dev-only.** No hard dependency on a specific WGSL parser in the production path.
- **Default warn, not throw.** A parser lagging the WGSL spec would emit false errors on legitimate-but-unusual layouts — exactly the exotic cases the kernel promises to support. Warn keeps it advisory.
- **Per-entry suppressible.** An author building an intentional superset layout can silence a specific check.
- **Cross-check only.** Reflection compares the explicit layout against the shader; it never becomes the layout's source of truth.

Net: catch the common mismatch early in the generate-run-fix loop, without making reflection authoritative or blocking exotic layouts.

### What Part 1 does NOT change

- **`BindSet` name is kept** (not renamed to `BindGroup`). `BindSet` does more than `GPUBindGroup` — allocation-version comparison, lazy rebuild, readiness exposure (`03-bindings`). The semantic difference is exactly why it must be named differently: a WebGPU-identical name would invite the wrong mental model and produce subtle bugs. Rule: name like WebGPU only where behavior matches; rename precisely where it diverges.
- The explicit `ScratchRuntime` / `Surface` split, explicit resource access and transfer declarations, `whenMissing` at the usage point, and `SubmissionValidationMode` (`off` / `warn` / `throw`) are kept. They are already AI-aligned: no hidden global state, local reasoning, and an error surface the agentic loop can iterate against.

## Part 2 — General-Purpose Compute Parity

Added after reviewing `00`–`05` against the requirement that `scratch` be a CPU-side interface to GPU capability — like WebGPU — and not only a graphics kernel. Serious high-performance parallel compute (simulation, scan/sort/reduce, iterative solvers, ML-style kernels) must be a first-class use.

### What already works

- `01-runtime-surface` already mandates compute-only / offscreen / worker runtimes not bound to a canvas. This is the GPGPU foundation.
- `04-pipelines-commands` indirect dispatch (`DispatchCount` `{ indirect }`) is the GPU-driven compute path: a previous pass's output count drives the next dispatch size.
- Storage buffer/texture read-write, override `constants` (parameterized workgroup size), and `requiredFeatures` / `requiredLimits` hooks are present.
- The declared resource access, explicit transfers, and dependency validation (`04` / `05` / `07`) are *more* valuable for compute chains (scan up/down-sweep, iterative solvers, simulate->sort->render) than for graphics — this is where GPGPU correctness most often breaks. The design's most "verbose" feature is its strongest compute asset.

### Gaps (ordered by severity)

#### Gap 1 — Positioning: "graphics kernel" undersold compute (fixed)

Earlier drafts called scratch "the **graphics** kernel"; `00-overview` said "graphics execution kernel"; compute appeared as "GPU compute-heavy **visualization**" and "visualization and compute tasks" — compute framed as serving visualization.

But the WebGPU analogy is the point: WebGPU is a **GPU** API, with graphics and compute co-equal. If compute is a first-class use, the top-level mental model should be re-centered as a **GPU execution kernel** (compute + graphics). Otherwise compute is silently treated as second-class in every downstream decision.

#### Gap 2 — Async readback was unmodeled (fixed at the vision level)

Across `00`–`05`, only `map` appears as a buffer usage (`02-resources`). There was no readback / `mapAsync` / awaitable-result mechanism: command families were Draw / Dispatch / Copy / Upload (no Readback), and the only submission unit was the older `frame…submit()` shape — fire-and-forget, with no `queue.onSubmittedWorkDone`.

GPGPU routinely needs: dispatch → copy to a readback buffer → `await map` → read on CPU → optionally feed the next pass. That path is currently inexpressible.

This also breaks Revision A's verifiability objective: without readback you cannot write a CPU-side test that asserts a compute kernel's output is correct. So this gap fails both the functional and the verifiability test.

Resolved (`07-transfers-epochs`): readback creates an explicit `ReadbackOperation` — `await readback.toArray()` — with an explicit `await` and provenance from the content epoch captured by the operation. `ReadbackCommand` is kept only as an ordered-staging escape hatch that produces the same operation type.

#### Gap 3 — Submission unit was presentation-flavored (fixed at the vision level)

Earlier `05` used `Frame` as the only submission unit, with presentation-leaning semantics (skip empty passes, current frame, surface integration). Compute is often not a frame: one-shot jobs, its own cadence, or N iterations before any present.

The model already handles "many dispatches recorded into one submission" well — good for GPU-bound iteration. What it does not handle is iteration with periodic CPU readback/feedback, which couples back to Gap 2.

Resolved (`05-passes-submissions-scheduler` / `07-transfers-epochs`): the scratch core submission unit is now `Submission`, not `Frame`. A submission may present to a surface, or it may be compute-only/offscreen. `Frame` cadence belongs above scratch core.

#### Gap 4 — No GPU timing / queries (fixed at the vision level)

Earlier `00`–`05` did not mention `timestamp-query` or `GPUQuerySet` (the only "profiling" reference was about validation mode, not GPU timing). "High-performance" implies measurement; without timestamp queries you cannot profile kernels. It is feature-gated, but the design needs a home for it: a query resource kind plus a pass/command touchpoint.

#### Gap 5 — Compute-specific validation + binding completeness (later)

- The `05` validator checks order / ownership / readiness but not compute limits: workgroup count vs `maxComputeWorkgroupsPerDimension`, storage binding size vs limits. These are silent failures today; fold them into the validator.
- `03-bindings` does not mention dynamic buffer offsets (`hasDynamicOffset`); binding one large buffer and selecting a slice per dispatch is a common compute batching pattern.

### Lens summary

- **Must fix**: Gap 1 (positioning drives every downstream decision), Gap 2 (fails functional + verifiability).
- **Should fix**: Gap 3 (functional; coupled to Gap 2), Gap 4 (precondition for "high-performance").
- **Later**: Gap 5.

Net: not a rewrite — raise compute from adjunct to first-class (reposition + add readback/submission semantics + leave room for timing and compute validation). Done right, the read/write dependency model becomes GPGPU's strength.

## Decision status

Applied to `00`–`05`, `07`, and `scratch-graphics-kernel.md`:

1. Revised primary objective wording in `00-overview` (Revision A).
2. Closure triage in `02-resources` and `04-pipelines-commands` (Revision B).
3. Reflection as a default-warn, suppressible dev cross-check in `03-bindings` (Revision C).
4. `BindSet` name stays (confirmed).
5. Re-centered as a "GPU execution kernel", compute co-equal (Gap 1).
6. Awaitable readback via explicit `ReadbackOperation`, `await readback.toArray()` (Gap 2) — see `07-transfers-epochs`.
7. Core submission unit renamed to `Submission` with `SubmissionBuilder` / `SubmittedWork` split (Gap 3) — see `05` and `07`.
8. Indexed `QuerySet` resource for timestamp/occlusion, `timestampWrites`, occlusion query brackets, and explicit resolve/readback operations (Gap 4) — see `07`.
9. Compute-limit checks and dynamic offsets in validation / bindings (Gap 5).

Resolution notes: Gaps 2–4 became one transfer/submission design across `05` and `07`. The submission naming issue (Gap 3) is resolved by using `Submission` as the only scratch core submission model; readback (Gap 2) is an explicit transfer operation with an explicit `await`; timing (Gap 4) reuses the same copy/readback path.
