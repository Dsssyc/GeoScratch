# ADR-049: Unify Scratch Attempt-Local Texture Handles

## Status

Proposed

## Date

2026-07-24

## Context

Scratch currently models persistent textures with `TextureResource` and borrows
the current canvas texture only while realizing a render attachment. WebGPU
also exposes two texture-like values whose validity is temporal rather than
persistent:

- `GPUExternalTexture`, imported from a video source and valid according to
  task or source-frame lifetime; and
- the texture returned by `GPUCanvasContext.getCurrentTexture()`, valid for the
  current presentation attempt.

Neither value has Scratch allocation versions, content epochs, replacement,
resize, destruction, or persistent resource identity. Treating either as a
`TextureResource` would fabricate ownership. Keeping separate hidden paths
would make binding, copying, render attachments, bundle realization, and
diagnostics disagree about which native texture belongs to one submission.

The frozen baseline is WebGPU CRD 14 July 2026, SHA-256
`23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30`.

## Decision Boundary

Phase 1 will complete this ADR before implementation. The accepted decision
must define one module-private attempt authority that:

- realizes each selected temporal texture at most once per submission attempt;
- shares that realization across every selected use in the attempt;
- never mutates persistent `PassSpec`, `Command`, `BindSet`, or resource state;
- validates exact Runtime, Surface, source, task/frame, configuration, and
  usage facts before native effects;
- expires every public borrowed handle at the attempt boundary or earlier
  lifecycle invalidation;
- keeps native handles out of persistent diagnostics and serialized evidence;
  and
- supports structured stale-handle, wrong-Runtime, unsupported-usage, and
  native-import diagnostics.

The public contracts must distinguish:

- an external texture source description that can be realized for a selected
  attempt;
- a submission-scoped surface texture lease that can produce validated views;
  and
- persistent `TextureResource` and `TextureViewSpec`.

External texture bind slots must accept every native resource category allowed
by the frozen WebGPU binding contract. A surface lease may be an attachment,
copy endpoint, or sampled binding only when the committed canvas
configuration permits that usage.

## Rejected Directions

- Persistent logical resources for external or presentation textures.
- A per-frame `prepare()` state machine.
- CPU pixel extraction or upload as a substitute for native import.
- Independent current-texture acquisition paths for attachments and other
  commands.
- Retaining video frames, pixels, native textures, or unbounded attempt
  histories in diagnostics.

## Acceptance Evidence

The completed ADR must be backed by focused lifecycle and anti-forgery tests,
cross-family binding/copy/attachment tests, bounded stress evidence, and
headed public-package browser proofs.
