# ADR-004: Keep the Default Runtime and Treat Src Wildcard as Compatibility

## Status

Superseded in part by ADR-006. The default runtime decision remains accepted; the `./src/*` package export decision is superseded by ADR-006.

## Date

2026-06-16

## Context

ADR-003 requires an architecture boundary pass before broad TypeScript migration. The most important current runtime boundary is the default global WebGPU runtime:

- `StartDash()` initializes the browser `GPUDevice`.
- `getDevice()` is used by lower-level GPU modules to access that device.
- The exported `director` owns frame orchestration and many resource creation events.
- Existing examples and consumers already import `StartDash`, `getDevice`, `device`, and `director` from the package entrypoint.

The package also exposed `./src/*` in this phase. That wildcard made migration easier for legacy consumers, but it weakened the public/internal boundary because any internal file could become observable API. This source wildcard conclusion is now superseded by ADR-006.

## Decision

Keep the default global runtime in this branch.

`StartDash()` remains the initializer for the default browser GPU device, and `director` remains the default global runtime orchestrator for existing examples. This preserves the current public design while making the boundary explicit enough to type and test.

`getDevice()` is a fast contract check. It returns the initialized default `GPUDevice` or throws a clear error telling the caller to invoke `StartDash()` first. It must not busy-wait for initialization.

Keep `./src/*` in `packages/geoscratch/package.json` as a deprecated compatibility aperture for this phase. New examples, docs, and tests must use explicit public entrypoints such as `geoscratch`, `geoscratch/scratch`, `geoscratch/geo`, and `geoscratch/geometry`. This compatibility aperture is now superseded by ADR-006, which removes `./src/*` as part of the Scratch TypeScript source and dist package boundary.

## Consequences

- Existing package consumers keep the same default runtime shape.
- Device ownership is explicit: initialization is asynchronous through `StartDash()`, while `getDevice()` is synchronous and requires prior initialization.
- Runtime misuse fails quickly instead of hanging the CPU.
- The package can move toward narrower public entrypoints without breaking legacy source-path consumers in this branch.
- A future runtime/context object remains possible, but it should be introduced behind this tested default-runtime contract.

## Non-Goals

- Do not replace the global `director` with a new runtime/context object in this phase.
- This phase did not remove `./src/*`; ADR-006 removes it later as part of the TypeScript Scratch and dist package boundary.
- Do not change examples to import internal source paths.
- Do not convert source files to TypeScript in this phase.
