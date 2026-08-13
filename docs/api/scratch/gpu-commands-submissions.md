---
docId: scratch.gpu-commands-submissions
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/gpu/command.ts
  - packages/geoscratch/src/scratch/gpu/debug-command.ts
  - packages/geoscratch/src/scratch/gpu/pass.ts
  - packages/geoscratch/src/scratch/gpu/query-set.ts
  - packages/geoscratch/src/scratch/gpu/render-bundle.ts
  - packages/geoscratch/src/scratch/gpu/submission-authority.ts
  - packages/geoscratch/src/scratch/gpu/submission.ts
---
# Commands And Submissions

[简体中文](./gpu-commands-submissions_zh.md) | [Scratch overview](./README.md)

Commands are immutable descriptions of native work. Scratch directly expresses draw,
indexed/indirect draw, dispatch/indirect dispatch, buffer and texture copy in every
WebGPU-supported direction, upload, clear, query, readback, external image upload,
debug markers, and render-bundle execution. Render and compute pass specs describe
encoder boundaries without creating a scene graph.

`SubmissionBuilder` orders pass steps and queue actions on one runtime timeline. It
validates ownership, mapping authority, content epochs, readiness policies, temporal
handles, resource conflicts, and query state, then produces `SubmittedWork` as the
inspectable receipt. `SubmissionAuthority` stamps asynchronous revisions so stale
prepare or feedback results cannot overwrite newer intent.

Scratch does not automatically reorder dependencies or hide queue submission. A caller
chooses strict, fallback, or skip readiness behavior explicitly. Validation failures
are structured diagnostics; native completion and error-scope evidence remain
asynchronous facts attached to the submitted work.
