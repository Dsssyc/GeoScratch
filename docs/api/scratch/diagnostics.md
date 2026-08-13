---
docId: scratch.diagnostics
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/diagnostics/base.ts
  - packages/geoscratch/src/scratch/diagnostics/index.ts
  - packages/geoscratch/src/scratch/gpu/diagnostics.ts
  - packages/geoscratch/src/scratch/gpu/gpu-operation.ts
  - packages/geoscratch/src/scratch/gpu/runtime-diagnostics.ts
---
# Diagnostics

[简体中文](./diagnostics_zh.md) | [Scratch overview](./README.md)

Diagnostics are machine-readable evidence, not console prose. A diagnostic carries a
stable domain, code, severity, phase, subject, evidence, expected/actual facts,
suggestions, and related records. `ScratchDiagnosticError` transports one diagnostic
through exception control flow without discarding its structure.

GPU diagnostics add bounded operation records, pending-operation facts, native error
outcomes, resource epochs, pressure evidence, and incident attribution.
`GPURuntimeDiagnostics` owns a bounded ledger for one runtime; capture objects define
explicit observation windows. The ledger is diagnostic history, not an unbounded
frame log and not a replacement for WebGPU error scopes or `device.lost`.

Callers own retention and export of reports. Runtime/resource identifiers establish
provenance, but diagnostics do not own or keep GPU resources alive. Native asynchronous
errors may only be attributed to the strongest available scope and timeline evidence;
the API never invents synchronous success for asynchronous WebGPU validation or OOM.

Use `createScratchDiagnostic` for domain-neutral records and the GPU-specific report
types when correlating operations. Branch on codes and facts, not message strings.
