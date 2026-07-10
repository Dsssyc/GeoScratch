# Scratch Submission Queue Order Audit

Status: complete for ADR-029
Date: 2026-07-11

Decision: `docs/decisions/ADR-029-scratch-submission-queue-timeline-ordering.md`

## RED Evidence

Against base `dev-feature` at `68c678d`, the first shared fake-queue timeline produced:

| Declared builder order | Required physical timeline | Base physical timeline | Result |
| --- | --- | --- | --- |
| upload -> copy | write-buffer -> submit | write-buffer -> submit | control passed |
| copy -> upload | submit -> write-buffer | write-buffer -> submit | RED |
| copy -> upload -> copy | submit -> write-buffer -> submit | write-buffer -> submit | RED |

The fix review added a second RED pass:

- an unavailable later `writeTexture` submitted an earlier command buffer before emitting its structured diagnostic;
- detached upload data threw after advancing the target epoch;
- an unexpected replay failure left an unperformed upload epoch committed and the builder retryable;
- generated public types exposed physical-write and logical-commit methods independently.

All four boundaries now have focused regression coverage.

## Step-Kind Audit

| `SubmissionStepKind` | Resolved-plan behavior | Prepared physical lowering | Replay behavior | Evidence |
| --- | --- | --- | --- | --- |
| `upload` | validates command, ownership, lifecycle, live data range, and queue capability before encoder creation | explicit `buffer-upload` or `texture-upload` action; ends a preceding encoder segment | queue write first, then commit that action's prepared target epoch | leading/trailing/interleaved, alternating, consecutive, detached-data, capability, partial-failure tests |
| `copy` | validates source readiness and required epoch in declared order | current maximal command-buffer segment | `queue.submit([segment])`, then commit segment effects | copy/upload/copy timeline, byte-order witness, existing four-direction copy suite |
| `readback` | validates one explicit source epoch and command uniqueness | staging copy in the current command-buffer segment | segment submit preserves the exact staging point; operation keeps aggregate `SubmittedWork` | readback-before-upload, upload-before-readback, readback/upload/readback byte and provenance tests |
| `resolve` | validates indexed query-slot epochs and destination | current maximal command-buffer segment | segment submit, then destination epoch effect | resolve/upload/resolve test plus existing query suite |
| `compute` | consumes only selected commands from the immutable readiness/fallback plan | executed pass in the current maximal segment; skipped/effect-free pass creates none | segment submit, then selected writes and query-slot effects | selected-fallback boundary test, skip tests, real WebGPU `Submission Order` proof |
| `render` | consumes only resolved render commands and pass effects | executed pass in the current maximal segment; skipped/effect-free pass creates none | segment submit, then command, attachment, timestamp, and occlusion effects | render/upload/render test plus existing attachment/query/readiness suites |

## Cross-Representation Audit

### Copy -> Upload -> Copy

1. `SubmissionBuilder.steps`: copy step 0, upload step 1, copy step 2.
2. Resolved plan: the same three steps; no fallback or skip changes.
3. Prepared timeline: command buffer 0, buffer upload, command buffer 1.
4. Fake queue timeline: `submit`, `write-buffer`, `submit`.
5. `SubmittedWork.commandBuffers`: exactly the two submitted segment objects in order.
6. `resourceAccesses`: copy read/write facts at step 0, upload write at step 1, copy read/write facts at step 2, with command identity and allocation version.
7. `producerEpochs`: first copy target, upload target, second copy target in steps 0, 1, 2.
8. Physical byte witness in `warn` and `off`: the first copy observes pre-upload bytes and the second copy observes post-upload bytes.

### Upload -> Readback -> Upload -> Readback

1. Builder and resolved plan retain all four explicit positions.
2. Prepared timeline is buffer upload, staging segment 0, buffer upload, staging segment 1.
3. Fake queue timeline is `write-buffer`, `submit`, `write-buffer`, `submit`.
4. `SubmittedWork.commandBuffers` contains both staging segments.
5. The operations use different staging buffers and capture epochs 1 and 2.
6. Producer provenance points to upload steps 0 and 2.
7. Materialized values remain `[1, 2]` and `[7, 8]`; the later upload does not alter the earlier staged bytes.

### Upload 0 -> Compute +1 -> Upload 10 -> Compute +1 -> Readback

1. Builder and resolved plan retain five ordered steps.
2. Prepared timeline is upload 0, compute segment 0, upload 10, compute/readback segment 1.
3. Real Chrome reports `document.body.dataset.status === "passed"`.
4. Real Chrome reports `document.body.dataset.result === "11"`.
5. The canvas is nonblank and visible, with no console error, page error, failed request, or HTTP failure.
6. The same example on the pre-fix submission path produces `12`, demonstrating that the browser result witnesses physical queue order rather than only logical ledger order.

## Failure And Completion Audit

- All expected structured validation failures complete before encoder creation and before the first queue action.
- Preparation simulates content state against snapshots and restores live resource/query state before replay.
- A preparation-time encoder failure restores resource and timestamp-query state and leaves the builder safely retryable.
- Each successful queue action commits only its own prepared logical effects.
- An unexpected synchronous replay failure leaves failed/later effects uncommitted and makes the builder non-retryable.
- Buffer and texture direct `execute(queue)` paths remain one validation, one physical write, and one epoch advance.
- Internal upload lowering is absent from the public command type surface.
- Upload-only work creates no encoder, command buffer, or queue submission and registers `done` after the final write.
- Effect-free work creates no queue action and uses an already-resolved completion promise.
- Encoder-only work without an upload boundary remains one encoder, one command buffer, and one queue submission.
- `SubmittedWork` remains non-thenable.

## Verification Evidence

- Focused queue-order suite: 25 passing.
- Full test suite: 384 passing.
- Public TypeScript contract: `npm run typecheck` passing.
- Package and examples build: `npm run build` passing.
- Whitespace/error check: `git diff --check` passing.
- Desktop Chrome at `?sample=submissionOrder`: result `11`, nonblank canvas, clean console/page/network/HTTP evidence.
- Mobile standalone Chrome: result `11`, no viewport overflow, clean console/page/network/HTTP evidence.
