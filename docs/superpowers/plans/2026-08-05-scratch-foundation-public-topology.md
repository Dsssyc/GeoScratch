# Scratch Foundation Public Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GeoScratch clean cut 为仅有 `scratch` 与 `geo` 两个公共概念入口，把现有 GPU、Worker、通用 geometry 归入领域无关的 Scratch 基础能力层，统一机器可读诊断，并在不丢失任何已实现 GPU/Worker 行为的前提下删除旧入口、旧 JavaScript API 和重复实现。

**Architecture:** `scratch` 是无 Geo 语义的能力基础层，由彼此独立的 `gpu`、`worker`、`geometry` 与共享无状态 `diagnostics` 组成；`geo` 只依赖 Scratch 的公开能力并保留坐标、投影、瓦片和虚拟栅格语义。`GPURuntime`、`WorkerSystem` 各自拥有生命周期和可变状态，不增加统一 platform runtime，不实现 Cache，也不把 DEM/Flow 业务提升为 Geo API。

**Tech Stack:** TypeScript ES modules, npm workspaces, WebGPU, Web Workers, Mocha, Chai, Vite, Playwright/Chrome browser probes.

## Global Constraints

- Goal 起点固定为提交 `e43d162150070c1d0b0cb0d61e27ac027a98ab64`，设计依据为 `docs/vision/scratch-foundation-public-topology.md`。
- 这是 `0.x.x` clean cut：不保留 deprecated alias、旧子路径、双导出、运行时 shim 或旧名称兼容层。
- 本 Goal 只改变代码归属、公共拓扑、GPU 命名和诊断 envelope；不得改变 GPU command/resource/submission/readiness/native-error 语义。
- 不得改变 Worker 的优先级、排队、取消、context retention、transfer、故障隔离或回收语义。
- 不实现 Persistent Cache，不修改 Geo virtual-raster cache 的模型，不推进 DEM 缓存和 Flow virtual-raster LoD。
- `GPURuntime`、`WorkerSystem` 不互相持有或调用内部实现；共享诊断类型不能引入共享可变状态。
- 所有生产源码保持 TypeScript source-first；源文件中的 ESM 相对导入继续使用 `.js` 后缀，以匹配编译产物。
- 每个任务只在其针对性测试转绿后提交，形成独立回滚点。不得在一个提交中同时移动源码、重命名全部 API、删除 legacy 和改文档。
- 不修改历史 ADR 的正文。旧名称只允许出现在迁移映射、历史 ADR/审计以及精确 allowlist 中。
- 不合并、不推送、不删除分支或 worktree；Goal 完成后等待单独的集成指令。

---

## Fixed Target Contract

### Package exports

`packages/geoscratch/package.json#exports` 最终必须精确等于：

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./scratch": {
    "types": "./dist/scratch.d.ts",
    "import": "./dist/scratch.js"
  },
  "./geo": {
    "types": "./dist/geo/index.d.ts",
    "import": "./dist/geo/index.js"
  },
  "./package.json": "./package.json"
}
```

### Root and subpath imports

```ts
import { scratch, geo } from 'geoscratch'
import { GPURuntime, WorkerSystem, plane, sphere } from 'geoscratch/scratch'
import { WebMercatorQuad, VirtualRasterAccessor } from 'geoscratch/geo'
```

`geoscratch` 根入口不得再扁平导出任何 class、factory 或 type。`geoscratch/worker` 与 `geoscratch/geometry` 必须无法解析。

### Target source tree

```text
packages/geoscratch/src/
├── index.ts
├── scratch.ts
├── scratch/
│   ├── index.ts
│   ├── diagnostics/
│   │   ├── base.ts
│   │   └── index.ts
│   ├── gpu/
│   │   ├── diagnostics.ts
│   │   └── *.ts (all current Scratch GPU implementation basenames)
│   ├── worker/
│   │   ├── diagnostics.ts
│   │   ├── index.ts
│   │   ├── module.ts
│   │   ├── protocol.ts
│   │   ├── worker-bootstrap.ts
│   │   └── worker-system.ts
│   ├── geometry/
│   │   ├── index.ts
│   │   ├── plane.ts
│   │   └── sphere.ts
│   └── internal/
│       └── uuid.ts
└── geo/
    └── *.ts plus retained projection/tiling/virtual-raster subdirectories
```

### Diagnostic contract

```ts
export type ScratchDiagnosticDomain = 'gpu' | 'worker'

export type ScratchDiagnosticBase<
    Domain extends ScratchDiagnosticDomain,
    Code extends string,
    Phase extends string,
    Subject extends ScratchDiagnosticSubject,
> = Readonly<{
    version: 1
    domain: Domain
    code: Code
    severity: 'info' | 'warn' | 'error'
    phase: Phase
    subject: Subject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    related?: readonly ScratchDiagnosticSubject[]
    suggestions?: readonly ScratchDiagnosticSuggestion[]
    evidence?: readonly ScratchDiagnosticEvidence[]
}>

export type ScratchDiagnostic = GPUDiagnostic | WorkerDiagnostic

export type ScratchDiagnosticErrorContext =
    | Readonly<{ domain: 'gpu'; incident?: GPUIncidentReport }>
    | Readonly<{ domain: 'worker'; remote?: WorkerRemoteErrorFacts }>
```

`ScratchDiagnosticError` 必须暴露 immutable `diagnostic`、`report` 和与 `diagnostic.domain` 一致的可选 `context`。GPU 的 ledger/capture/incident 仍只由 `GPURuntime` 拥有；Worker 不获得 GPU ledger，GPU 也不获得 Worker queue/context 状态。

---

## File Responsibility Map

- `packages/geoscratch/src/index.ts`: 只构造并导出 `scratch`、`geo` namespace。
- `packages/geoscratch/src/scratch.ts`: `geoscratch/scratch` 的正式 ESM 门面，重导出 `scratch/index.ts`。
- `packages/geoscratch/src/scratch/index.ts`: Scratch 全部公共 value/type 的唯一清单。
- `packages/geoscratch/src/scratch/diagnostics/base.ts`: 跨 Scratch 域的 immutable envelope、report、error、type guard 和 factory。
- `packages/geoscratch/src/scratch/diagnostics/index.ts`: 组装 `GPUDiagnostic | WorkerDiagnostic`，不持有任何 runtime 状态。
- `packages/geoscratch/src/scratch/gpu/`: 当前完整 Scratch WebGPU 实现和 GPU 专属 diagnostics/ledger。
- `packages/geoscratch/src/scratch/worker/`: 当前完整 Worker 实现和 Worker 专属 code/phase/facts。
- `packages/geoscratch/src/scratch/geometry/`: 无 Geo 语义的 `plane`、`sphere` TypeScript mesh generator。
- `packages/geoscratch/src/scratch/internal/uuid.ts`: Scratch 内部 identity helper，不公开。
- `packages/geoscratch/src/geo/index.ts`: Geo 唯一公共清单；不导出旧 quadtree。
- `packages/geoscratch/package.json`: 仅声明四个批准的 export key。
- `packages/geoscratch/tsconfig.build.json`: 最终禁止同源 JavaScript 编译输入。
- `tests/scratch-foundation-source-topology.test.js`: 物理目录、无反向依赖、无同源 JS/d.ts 门禁。
- `tests/scratch-foundation-diagnostics.test.js`: GPU/Worker unified diagnostic 契约与错误窄化。
- `tests/scratch-foundation-public-topology.test.js`: 最终 package/root/subpath/export 精确门禁。
- `tests/scratch-geometry-parity.test.js`: `plane`/`sphere` 迁移前后字节事实一致性。
- `tests/types/scratch-foundation-public-api.ts`: 最终 TypeScript 正向/负向公共契约。
- `tests/audits/scratch-foundation-public-topology.mjs`: 基线符号分类、重命名和删除完备性审计。
- `docs/review/manifests/scratch-foundation-public-symbols.json`: 机器可读的基线到目标一对一处置清单。
- `docs/review/manifests/scratch-foundation-legacy-name-allowlist.json`: 历史文档旧名称的精确保留清单。
- `docs/review/scratch-foundation-public-topology-final-audit.md`: 最终事实矩阵和门禁结果。
- `docs/decisions/ADR-057-scratch-foundation-public-topology.md`: 接受后的公共架构决策。

---

### Task 1: Inventory Every Public Symbol And Move The GPU Domain

**Files:**
- Create: `docs/review/manifests/scratch-foundation-public-symbols.json`
- Create: `tests/audits/scratch-foundation-public-topology.mjs`
- Create: `tests/scratch-foundation-source-topology.test.js`
- Move: every `packages/geoscratch/src/scratch/*.ts` except `packages/geoscratch/src/scratch/index.ts` to the same basename under `packages/geoscratch/src/scratch/gpu/`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/geo/virtual-raster-gpu.ts`
- Modify: every file returned by `rg -l "packages/geoscratch/src/scratch/[A-Za-z0-9_-]+\\.ts" tests`

- [ ] Generate the manifest from baseline commit `e43d162` and classify every exported value/type from root, `./scratch`, `./worker`, `./geometry`, and `./geo` exactly once as `preserve`, `rename`, `move`, or `remove`; reject duplicate and unclassified symbols in the audit script.
- [ ] Add a RED source-topology test asserting that `scratch/index.ts` is the only TypeScript file directly under `scratch/`, all current GPU implementation basenames exist under `scratch/gpu/`, and no GPU source imports `scratch/worker` or `geo`.
- [ ] Move files without changing public names or runtime behavior. Preserve each file body first; only adjust relative import paths and the `scratch/index.ts` barrel.
- [ ] Update `geo/virtual-raster-gpu.ts` to import its GPU types from `../scratch/gpu/` during this internal-layout phase. Do not rename `ScratchRuntime` yet.
- [ ] Replace every exact source-evidence path in `tests/audits/`, `tests/browser/`, `tests/stress/`, `tests/benchmarks/`, and `tests/*.test.js`; do not weaken source inventories or replace them with broad directory checks.
- [ ] Run `node --test` nowhere; this repository uses Mocha. Run `npm test -- --grep "scratch foundation source topology"` and every source-audit test whose path inventory changed.
- [ ] Run `npm run typecheck` and `npm run build`; expected result is success with unchanged public declarations.
- [ ] Commit as `Move Scratch GPU implementation into its domain`.

### Task 2: Move Worker Into Scratch Without Changing Worker Semantics

**Files:**
- Move: `packages/geoscratch/src/worker/diagnostics.ts` to `packages/geoscratch/src/scratch/worker/diagnostics.ts`
- Move: `packages/geoscratch/src/worker/index.ts` to `packages/geoscratch/src/scratch/worker/index.ts`
- Move: `packages/geoscratch/src/worker/module.ts` to `packages/geoscratch/src/scratch/worker/module.ts`
- Move: `packages/geoscratch/src/worker/protocol.ts` to `packages/geoscratch/src/scratch/worker/protocol.ts`
- Move: `packages/geoscratch/src/worker/worker-bootstrap.ts` to `packages/geoscratch/src/scratch/worker/worker-bootstrap.ts`
- Move: `packages/geoscratch/src/worker/worker-system.ts` to `packages/geoscratch/src/scratch/worker/worker-system.ts`
- Modify: `packages/geoscratch/src/worker.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `tests/worker-bootstrap-deployment.test.js`
- Modify: `tests/worker-public-api.test.js`
- Modify: `tests/worker-system.test.js`
- Modify: `tests/browser/worker-system.mjs`
- Modify: `tests/fixtures/worker-system.ts`
- Modify: `tests/fixtures/worker-system-module.ts`

- [ ] Extend the source-topology test with RED assertions that Worker production files exist only under `scratch/worker/` and do not import GPU, Geo, Cache, DOM canvas, or GPU runtime state.
- [ ] Move the Worker source verbatim apart from necessary relative imports. Keep `packages/geoscratch/src/worker.ts` as the temporary old subpath forwarding file until Task 6 so this task can isolate physical movement from public deletion.
- [ ] Re-export Worker values/types from `scratch/index.ts` while retaining the temporary `./worker` export only until Task 6.
- [ ] Preserve module loading, priority ordering, queued/cooperative/stale/hard cancellation, context retention, transferable ownership, failure isolation, group disposal, system disposal, and worker reclamation assertions unchanged.
- [ ] Run `npm test -- --grep "WorkerSystem|worker public API|worker bootstrap"`, `npm run typecheck`, and `node tests/browser/worker-system.mjs`.
- [ ] Commit as `Move Worker into Scratch foundation`.

### Task 3: Unify Scratch Diagnostics Without Sharing Domain State

**Files:**
- Create: `packages/geoscratch/src/scratch/diagnostics/base.ts`
- Create: `packages/geoscratch/src/scratch/diagnostics/index.ts`
- Modify: `packages/geoscratch/src/scratch/gpu/diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/worker/diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/worker/worker-system.ts`
- Modify: GPU files importing `./diagnostics.js`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Create: `tests/scratch-foundation-diagnostics.test.js`
- Modify: `tests/scratch-diagnostics.test.js`
- Modify: `tests/worker-public-api.test.js`
- Modify: `tests/worker-system.test.js`
- Modify: `tests/fixtures/worker-system.ts`
- Modify: `tests/types/public-api.ts`

- [ ] Add RED tests proving `createScratchDiagnostic()` requires an explicit `domain`, freezes the envelope plus copied library-owned subject/list entries, does not mutate opaque caller-owned `expected`/`actual` values, and returns a union narrowed by `diagnostic.domain`.
- [ ] Add RED tests proving GPU and Worker failures are both `ScratchDiagnosticError`, `isScratchDiagnosticError()` recognizes only branded instances, and an error context domain must match its diagnostic domain.
- [ ] Implement `ScratchDiagnosticBase`, `ScratchDiagnostic`, `ScratchDiagnosticInput`, `ScratchDiagnosticReport`, `ScratchDiagnosticErrorContext`, `ScratchDiagnosticError`, `createScratchDiagnostic`, `createScratchDiagnosticReport`, and `isScratchDiagnosticError` in the shared diagnostics domain.
- [ ] Export the common public values `ScratchDiagnosticError`, `createScratchDiagnostic`, `createScratchDiagnosticReport`, and `isScratchDiagnosticError`; keep domain throw helpers internal and remove `throwScratchDiagnostic` from the public facade.
- [ ] Keep GPU-only phase/subject/facts in `gpu/diagnostics.ts`; provide internal `createGPUDiagnostic()` and `throwGPUDiagnostic()` helpers so every GPU call emits `domain: 'gpu'` without exporting a second public envelope.
- [ ] Keep Worker-only code/phase/subject/cancellation/remote facts in `worker/diagnostics.ts`; retain an internal `workerDiagnosticError()` factory returning `ScratchDiagnosticError<WorkerDiagnostic>`.
- [ ] Delete `WorkerDiagnosticError` and `createWorkerDiagnostic` as public and internal concepts. Update typed Worker failure slots and tests to the common error while preserving remote stack, cause, retriable, cancellation kind, and task/group/module facts.
- [ ] Replace the old public `.incident` field with `error.context` and migrate all GPU tests/call sites. Never copy GPU incident state into Worker diagnostics.
- [ ] Ensure `createScratchDiagnosticReport()` accepts mixed GPU/Worker diagnostics, remains immutable, and computes counts without reinterpreting domain-specific codes.
- [ ] Run `npm test -- --grep "Scratch foundation diagnostics|scratch diagnostics|WorkerSystem|worker public API"` and `npm run typecheck`.
- [ ] Commit as `Unify Scratch diagnostic envelopes`.

### Task 4: Apply The Complete GPU Naming Clean Cut

**Files:**
- Modify: all `packages/geoscratch/src/scratch/gpu/*.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/geo/virtual-raster-gpu.ts`
- Modify: all Scratch-consuming `examples/*/main.ts` and helper `.ts` files
- Modify: all `tests/scratch-*.test.js`, `tests/geo-*.test.js`, `tests/fixtures/*.ts`, `tests/audits/*.mjs`, `tests/browser/*.mjs`, `tests/stress/*.mjs`, `tests/benchmarks/*.mjs`, and `tests/types/public-api.ts` containing mapped names
- Modify: `docs/review/manifests/scratch-foundation-public-symbols.json`
- Modify: `tests/audits/scratch-foundation-public-topology.mjs`

- [ ] Add RED type/runtime contract assertions for `GPURuntime`, `GPURuntimeDiagnostics`, `GPUDiagnosticCapture`, `GPUIncidentReport`, `GPUOperationRecord`, `RenderPipeline`, and `ComputePipeline`, plus negative assertions that old names are absent.
- [ ] Apply every mapping in Appendix A mechanically across production source, examples, active tests, type fixtures, audit code, runtime subject kinds, constructor names, error messages that identify API names, and manifest entries.
- [ ] Do not GPU-prefix the cross-domain diagnostic names listed after Appendix A; all other GPU-only `Scratch*`/`Gpu*` identifiers and the `'GpuOperation'` subject kind follow the public and internal rename maps.
- [ ] Rename `ScratchRenderPipeline`/`ScratchComputePipeline` exports to `RenderPipeline`/`ComputePipeline`; do not retain aliases because the legacy classes with those names are removed in Task 6.
- [ ] Prove `GPURuntime.create()` remains the sole construction path, remains async, and retains runtime-authority, device-loss, dispose, capture, resource ownership, and submitted-work behavior.
- [ ] Run `npm test -- --grep "scratch runtime|scratch diagnostics|GPU operation|pipeline|submission|readback"`, `npm run typecheck`, and `npm run build`.
- [ ] Run `rg -n` for every Appendix A old name over `packages/geoscratch/src`, `examples`, and active tests; expected result is zero except the migration manifest/audit assertions.
- [ ] Commit as `Rename Scratch GPU public contracts`.

### Task 5: Migrate Geometry And UUID To TypeScript With Fact Parity

**Files:**
- Create: `packages/geoscratch/src/scratch/geometry/index.ts`
- Create: `packages/geoscratch/src/scratch/geometry/plane.ts`
- Create: `packages/geoscratch/src/scratch/geometry/sphere.ts`
- Create: `packages/geoscratch/src/scratch/internal/uuid.ts`
- Modify: Scratch GPU files importing UUID
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `examples/helloGAW/main.ts`
- Create: `tests/scratch-geometry-parity.test.js`
- Modify: `tests/module-layout.test.js`

- [ ] Before deleting legacy files, add parity tests that `JSON.stringify()` each output and SHA-256 hashes it. Require these exact facts:

```text
plane(0)                          fcbaddf9c8b86764363c623109a280788aab2f49d4c3b93488bacaa3ab253f58
plane(2)                          1cb90b38eed1c34efefb641cec29653a6236c70964244f7a8a2a520c628d9058
plane(6)                          cd6e5be6682be080e083c09938ef385fcdd523084f0c2515f18cad0f0a92807a
sphere()                          6e3c5099fe0e290e245161f6879d6fa4582abb54ff9e5ebde76e65605c10791e
sphere(1, 8, 4)                   f13ef65c02cb94d1fcc06878a3c86168346f1e2055bba587a9479bb499b6899b
sphere(1, 8, 4, .2, 3, .1, 1.7)  8f95f0bcd73b10230f51733251459c44bd44759f71c2608195c0550c6eb79204
```

- [ ] Port `plane` and `sphere` line-for-line in algorithm and return shape, adding explicit TypeScript tuple/array/result types only. Do not “correct” triangulation, winding, UV, subdivision, duplicate-vertex, or numeric behavior in this Goal.
- [ ] Move UUID generation to `scratch/internal/uuid.ts`, preserve UUID v4 bit layout and lowercase output, and update all GPU imports. Do not export UUID from `scratch/index.ts`.
- [ ] Export only `plane`, `sphere`, `PlaneGeometry`, and `SphereGeometry` from `scratch/geometry/index.ts` and the Scratch facade.
- [ ] Update DEM and Hello GAW to import geometry through `geoscratch/scratch`; keep rendering code and visible output unchanged.
- [ ] Run `npm test -- --grep "scratch geometry parity|module layout|DEM Layer|Hello GAW"`, `npm run typecheck`, and `npm run build`.
- [ ] Commit as `Migrate Scratch geometry and identity helpers to TypeScript`.

### Task 6: Cut The Final Public Surface And Delete Legacy Implementations

**Files:**
- Rewrite: `packages/geoscratch/src/index.ts`
- Modify: `packages/geoscratch/src/scratch.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `packages/geoscratch/package.json`
- Modify: `packages/geoscratch/tsconfig.build.json`
- Modify: `tsconfig.types.json`
- Modify: `tsconfig.webgpu-types.json`
- Delete: `packages/geoscratch/src/worker.ts`
- Delete: `packages/geoscratch/src/worker/`
- Delete: `packages/geoscratch/src/geometry/`
- Delete: `packages/geoscratch/src/gpu/`
- Delete: `packages/geoscratch/src/effects/`
- Delete: `packages/geoscratch/src/loaders/`
- Delete: `packages/geoscratch/src/core/`
- Delete: `packages/geoscratch/src/geo/tiling/geoQuadNode2D.ts`
- Modify: all `examples/**/*.ts` imports
- Create: `tests/scratch-foundation-public-topology.test.js`
- Create: `tests/types/scratch-foundation-public-api.ts`
- Modify: `tests/public-entry.test.js`
- Modify: `tests/type-contracts.test.js`
- Modify: `tests/module-layout.test.js`
- Modify: `tests/workspace-layout.test.js`
- Modify: `tests/examples-structure.test.js`
- Modify: `tests/geo-typescript-migration.test.js`
- Modify: `tests/architecture-boundary.test.js`

- [ ] Add RED runtime export tests asserting root keys are exactly `['geo', 'scratch']`; `geoscratch/scratch` equals the approved Scratch manifest; `geoscratch/geo` equals the approved Geo manifest; and package export keys are exactly `.`, `./scratch`, `./geo`, `./package.json`.
- [ ] Add RED negative import tests for `geoscratch/worker` and `geoscratch/geometry`, and negative type assertions for every removed root flat export and old GPU name.
- [ ] Rewrite root entry as namespace-only exports:

```ts
import * as geo from './geo/index.js'
import * as scratch from './scratch/index.js'

export { geo, scratch }
```

- [ ] Keep `scratch.ts` as the formal `./scratch` facade, not a compatibility shim. Delete `worker.ts` and both package subpath exports.
- [ ] Change every example/fixture consumer to import GPU, Worker and geometry from `geoscratch/scratch`, and Geo contracts from `geoscratch/geo`. Do not use source-relative imports to bypass package boundaries.
- [ ] Remove `GeoQuadNode2D` and `Node2D` from `geo/index.ts`; delete old quadtree and `BoundingBox2D`. Keep `MercatorCoordinate` only in `geo/mercatorCoordinate.ts`; delete the duplicate core version.
- [ ] Delete the old global-device GPU stack, effects, loaders, ArrayRef, BlockRef, numeric wrappers, ScratchObject, random helper, old geometry copies, all same-source `.js`, and all handwritten `.d.ts` files.
- [ ] Set `allowJs: false` in `packages/geoscratch/tsconfig.build.json`, `tsconfig.types.json`, and `tsconfig.webgpu-types.json`; remove the deleted `packages/geoscratch/src/core/utils/uuid.js` includes. Assert that no `.js`, `.d.js`, or handwritten `.d.ts` remains under `packages/geoscratch/src/`.
- [ ] Keep every current Geo coordinate/high-precision/tile-matrix/WebMercator/virtual-raster export, except the explicitly removed old quadtree types. Do not rewrite `virtual-raster-cache.ts`.
- [ ] Run `npm test -- --grep "foundation public topology|public entry|type contracts|module layout|workspace layout|examples structure|Geo TypeScript"`, `npm run typecheck`, and `npm run build`.
- [ ] Run the topology audit and require every baseline export to have exactly one final disposition with no unclassified deletion.
- [ ] Commit as `Cut Scratch and Geo public entrypoints`.

### Task 7: Publish The Accepted Architecture And Exact Historical Allowlist

**Files:**
- Create: `docs/decisions/ADR-057-scratch-foundation-public-topology.md`
- Create: `docs/review/manifests/scratch-foundation-legacy-name-allowlist.json`
- Create: `tests/scratch-foundation-docs.test.js`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `packages/geoscratch/README.md`
- Modify: `packages/geoscratch/README_zh.md`
- Modify: `docs/vision/scratch-graphics-kernel.md`
- Modify: all bilingual modules under `docs/vision/scratch-api/`
- Modify: relevant modules under `docs/vision/geo-api/`
- Modify: `docs/vision/scratch-foundation-public-topology.md`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`
- Modify: `docs/review/scratch-webgpu-wgsl-structured-proof-review.md`

- [ ] Write ADR-057 with the two public concepts, one-way `geo -> scratch` dependency, independent GPU/Worker lifecycle authorities, namespace-only root, diagnostic union, exact deleted subpaths, and explicit Goal 2/3 exclusions.
- [ ] State that ADR-057 supersedes ADR-056 only for Worker public topology; retain ADR-056 scheduling/cancellation/context/transfer semantics.
- [ ] Update user-facing docs to show only the three approved import forms. Explain `GPURuntime`, Worker independence, TypeScript source-first, and “Geo from the Scratch” without documenting removed compatibility paths.
- [ ] Update active vision and living review documents to current names. Keep design history intact and mark `scratch-foundation-public-topology.md` implemented by ADR-057.
- [ ] Build the historical-name allowlist as exact `{ path, symbol, reason }` entries. No directory glob, filename glob, wildcard symbol, or blanket `docs/decisions` exemption is allowed.
- [ ] Add docs tests that fail when an old mapped name appears in active source/docs outside the allowlist, when an allowlisted occurrence disappears without manifest cleanup, or when README/package examples use root flat imports.
- [ ] Run `npm test -- --grep "scratch foundation docs"`, `npm run typecheck`, and `npm run build`.
- [ ] Commit as `Document Scratch foundation public topology`.

### Task 8: Execute Fixed Gates And One Bounded Final Review

**Files:**
- Create: `docs/review/scratch-foundation-public-topology-final-audit.md`
- Modify: only Goal 1 files required by deterministic gate failures or the single bounded diff review

- [ ] Start from a clean worktree and record `git rev-parse HEAD`, Node/npm versions, browser version, adapter/device facts emitted by browser probes, and the exact command list in the final audit.
- [ ] Run this full gate exactly once in the listed order:

```bash
npm run typecheck
npm test
npm run build
node tests/audits/scratch-webgpu-wgsl-current-coverage.mjs
node tests/browser/worker-system.mjs
node tests/browser/scratch-hello-gaw.mjs
node tests/browser/scratch-dem-layer.mjs
node tests/browser/scratch-flow-layer.mjs
```

- [ ] For browser gates, require zero uncaptured WebGPU errors, zero device loss, zero leaked Worker, and the currently accepted visible Hello GAW, DEM Layer, and Flow Layer results. Do not reinterpret an infrastructure interruption as a product failure.
- [ ] If a gate has a deterministic Goal 1 failure, record command/error/root cause, fix only that cause, and rerun only the failed gate plus directly affected gates. Do not restart the entire review loop.
- [ ] Perform one final review limited to `git diff e43d162..HEAD` across correctness, public-contract completeness, architecture direction, accidental deletion, TypeScript declaration output, diagnostics immutability, Worker semantic parity, and browser-visible regressions.
- [ ] Reconcile the manifest against final exports and record a preserved/renamed/moved/removed matrix. Explicitly confirm that every pre-goal GPU and Worker behavior has a current implementation and test owner.
- [ ] Run final hygiene commands:

```bash
git diff --check e43d162..HEAD
git status --short
rg -n "geoscratch/(worker|geometry)" packages examples tests README.md README_zh.md
rg -n "ScratchRuntime|ScratchDiagnosticCapture|ScratchRenderPipeline|ScratchComputePipeline|WorkerDiagnosticError|createWorkerDiagnostic" packages examples tests README.md README_zh.md docs/vision docs/review
```

- [ ] Interpret expected `rg` matches only through the exact historical allowlist; any unlisted match is a finding, not an excuse to broaden the allowlist.
- [ ] Commit the final audit and any in-scope corrections as `Audit Scratch foundation topology migration`.
- [ ] Stop the Goal. Report `confirmed-clean` when all required gates and review rows pass; otherwise report `completed-with-findings` and list each failed command, root cause, impact, retained evidence, and recommended next action. Do not mark blocked and do not begin Goal 2.

---

## Appendix A: Exact Public Rename Map

The following public names are mandatory one-to-one clean-cut renames. The old side must have no runtime/type alias after Task 4.

```text
ScratchAdapterInfoSnapshot                  -> GPUAdapterInfoSnapshot
ScratchBufferMappingFailureStage            -> GPUBufferMappingFailureStage
ScratchDeviceLostInfo                       -> GPUDeviceLostInfo
ScratchDiagnosticCapture                    -> GPUDiagnosticCapture
ScratchDiagnosticCaptureOptions             -> GPUDiagnosticCaptureOptions
ScratchDiagnosticCaptureReport              -> GPUDiagnosticCaptureReport
ScratchDiagnosticCaptureStopReason          -> GPUDiagnosticCaptureStopReason
ScratchFeatureLevel                         -> GPUFeatureLevel
ScratchGpuBindLayoutOperationRecord          -> GPUBindLayoutOperationRecord
ScratchGpuBindLayoutOperationTarget          -> GPUBindLayoutOperationTarget
ScratchGpuBindSetOperationRecord             -> GPUBindSetOperationRecord
ScratchGpuBindSetOperationTarget             -> GPUBindSetOperationTarget
ScratchGpuBindSetPreparationStage            -> GPUBindSetPreparationStage
ScratchGpuBufferMappingIncidentReport        -> GPUBufferMappingIncidentReport
ScratchGpuCommandOperationRecord             -> GPUCommandOperationRecord
ScratchGpuCommandOperationTarget             -> GPUCommandOperationTarget
ScratchGpuContentResourceOperationTarget     -> GPUContentResourceOperationTarget
ScratchGpuIncidentEvidenceCompleteness       -> GPUIncidentEvidenceCompleteness
ScratchGpuIncidentFailureStage               -> GPUIncidentFailureStage
ScratchGpuIncidentKind                       -> GPUIncidentKind
ScratchGpuIncidentOutcome                    -> GPUIncidentOutcome
ScratchGpuIncidentQuery                      -> GPUIncidentQuery
ScratchGpuIncidentReport                     -> GPUIncidentReport
ScratchGpuIncidentTarget                     -> GPUIncidentTarget
ScratchGpuOperationQuery                     -> GPUOperationQuery
ScratchGpuOperationRecord                    -> GPUOperationRecord
ScratchGpuOperationTarget                    -> GPUOperationTarget
ScratchGpuPipelineFailureStage               -> GPUPipelineFailureStage
ScratchGpuPipelineOperationRecord            -> GPUPipelineOperationRecord
ScratchGpuPipelineOperationTarget            -> GPUPipelineOperationTarget
ScratchGpuPressureContributor                -> GPUPressureContributor
ScratchGpuPressureEvidence                   -> GPUPressureEvidence
ScratchGpuQuerySetOperationTarget            -> GPUQuerySetOperationTarget
ScratchGpuQuerySetSlotFact                   -> GPUQuerySetSlotFact
ScratchGpuReadbackIncidentReport             -> GPUReadbackIncidentReport
ScratchGpuReadbackOperationRecord            -> GPUReadbackOperationRecord
ScratchGpuReadbackOperationTarget            -> GPUReadbackOperationTarget
ScratchGpuRenderBundleOperationRecord        -> GPURenderBundleOperationRecord
ScratchGpuRenderBundleOperationTarget        -> GPURenderBundleOperationTarget
ScratchGpuResourceOperationRecord            -> GPUResourceOperationRecord
ScratchGpuResourceOperationTarget            -> GPUResourceOperationTarget
ScratchGpuRuntimeIncidentTarget              -> GPURuntimeIncidentTarget
ScratchGpuSamplerOperationTarget             -> GPUSamplerOperationTarget
ScratchGpuShaderModuleOperationRecord        -> GPUShaderModuleOperationRecord
ScratchGpuShaderModuleOperationTarget        -> GPUShaderModuleOperationTarget
ScratchGpuSubmissionIncidentReport           -> GPUSubmissionIncidentReport
ScratchGpuSubmissionOperationRecord          -> GPUSubmissionOperationRecord
ScratchGpuSubmissionOperationTarget          -> GPUSubmissionOperationTarget
ScratchGpuSupportingObjectIncidentReport     -> GPUSupportingObjectIncidentReport
ScratchNativeGpuErrorFacts                   -> GPUNativeErrorFacts
ScratchPendingGpuOperationFact               -> GPUPendingOperationFact
ScratchPipelineNativeLabelEvidence           -> GPUPipelineNativeLabelEvidence
ScratchPipelineNativeLabelFact               -> GPUPipelineNativeLabelFact
ScratchReadbackCommandState                  -> GPUReadbackCommandState
ScratchReadbackFailureStage                  -> GPUReadbackFailureStage
ScratchReadbackNativeOutcome                 -> GPUReadbackNativeOutcome
ScratchReadbackNativeOutcomeFact             -> GPUReadbackNativeOutcomeFact
ScratchReadbackNativeOutcomeInput            -> GPUReadbackNativeOutcomeInput
ScratchReadbackNativeStage                   -> GPUReadbackNativeStage
ScratchReadbackOptions                       -> GPUReadbackOptions
ScratchReadbackPolicy                        -> GPUReadbackPolicy
ScratchRuntime                               -> GPURuntime
ScratchRuntimeAdapterRequestFacts            -> GPURuntimeAdapterRequestFacts
ScratchRuntimeBindLayoutFact                 -> GPURuntimeBindLayoutFact
ScratchRuntimeBindSetFact                    -> GPURuntimeBindSetFact
ScratchRuntimeBufferMappingFact              -> GPURuntimeBufferMappingFact
ScratchRuntimeContentResourceFact            -> GPURuntimeContentResourceFact
ScratchRuntimeCreateOptions                  -> GPURuntimeCreateOptions
ScratchRuntimeDeviceRequestFacts             -> GPURuntimeDeviceRequestFacts
ScratchRuntimeDiagnostics                    -> GPURuntimeDiagnostics
ScratchRuntimeDiagnosticsEvidence            -> GPURuntimeDiagnosticsEvidence
ScratchRuntimeDiagnosticsOptions             -> GPURuntimeDiagnosticsOptions
ScratchRuntimeDiagnosticsSnapshot            -> GPURuntimeDiagnosticsSnapshot
ScratchRuntimePipelineFact                   -> GPURuntimePipelineFact
ScratchRuntimeQuerySetResourceFact           -> GPURuntimeQuerySetResourceFact
ScratchRuntimeReadbackCommandFact            -> GPURuntimeReadbackCommandFact
ScratchRuntimeReadbackOperationFact          -> GPURuntimeReadbackOperationFact
ScratchRuntimeRequestFacts                   -> GPURuntimeRequestFacts
ScratchRuntimeResourceFact                   -> GPURuntimeResourceFact
ScratchRuntimeSamplerResourceFact            -> GPURuntimeSamplerResourceFact
ScratchSubmissionFailureStage                -> GPUSubmissionFailureStage
ScratchSubmissionNativeLocation              -> GPUSubmissionNativeLocation
ScratchSubmissionNativeOutcome               -> GPUSubmissionNativeOutcome
ScratchSubmissionNativeOutcomeFact           -> GPUSubmissionNativeOutcomeFact
ScratchSubmissionNativeOutcomeInput          -> GPUSubmissionNativeOutcomeInput
ScratchSubmissionNativeOutcomeMode           -> GPUSubmissionNativeOutcomeMode
ScratchSubmissionNativeOutcomeStatus         -> GPUSubmissionNativeOutcomeStatus
ScratchSubmissionNativeStage                 -> GPUSubmissionNativeStage
ScratchSubmissionQueueActionKind             -> GPUSubmissionQueueActionKind
ScratchSubmissionScopeMode                   -> GPUSubmissionScopeMode
ScratchSupportingObjectFailureStage          -> GPUSupportingObjectFailureStage
GpuAttributionConfidence                     -> GPUAttributionConfidence
GpuDescriptorEvidence                        -> GPUDescriptorEvidence
GpuNativeErrorCategory                       -> GPUNativeErrorCategory
GpuOperationKind                             -> GPUOperationKind
GpuOperationStatus                           -> GPUOperationStatus
ScratchRenderPipeline                        -> RenderPipeline
ScratchComputePipeline                       -> ComputePipeline
ScratchRenderPipelineDescriptor              -> RenderPipelineDescriptor
ScratchComputePipelineDescriptor             -> ComputePipelineDescriptor
DiagnosticSubject                            -> ScratchDiagnosticSubject
DiagnosticSeverity                           -> ScratchDiagnosticSeverity
DiagnosticSuggestion                         -> ScratchDiagnosticSuggestion
DiagnosticEvidence                           -> ScratchDiagnosticEvidence
DiagnosticPhase                              -> GPUDiagnosticPhase
```

The following non-public implementation identifiers are also renamed in the same task so GPU internals do not retain misleading `ScratchRuntime`/`ScratchGpu` terminology:

```text
ScratchBindingSupportedLimits                -> GPUBindingSupportedLimits
ScratchCanvas                                -> GPUCanvas
ScratchEffectfulSubmittedWorkReservation     -> GPUEffectfulSubmittedWorkReservation
ScratchFeatureDependency                     -> GPUFeatureDependency
ScratchGpuIncidentInput                      -> GPUIncidentInput
ScratchGpuIncidentPendingOperation           -> GPUIncidentPendingOperation
ScratchGpuIncidentPipelineFact               -> GPUIncidentPipelineFact
ScratchGpuIncidentReportBase                 -> GPUIncidentReportBase
ScratchGpuIncidentReportInput                -> GPUIncidentReportInput
ScratchGpuIncidentResourceFact               -> GPUIncidentResourceFact
ScratchGpuOperationCompletion                -> GPUOperationCompletion
ScratchGpuOperationRecordBase                -> GPUOperationRecordBase
ScratchGpuOperationRecordInput               -> GPUOperationRecordInput
ScratchGpuOperationStart                     -> GPUOperationStart
ScratchGpuPipelineIncidentReport             -> GPUPipelineIncidentReport
ScratchGpuPressureChurn                      -> GPUPressureChurn
ScratchGpuResourceIncidentReport             -> GPUResourceIncidentReport
ScratchGpuRuntimeIncidentReport              -> GPURuntimeIncidentReport
ScratchJsonPrimitive                         -> GPUJsonPrimitive
ScratchJsonValue                             -> GPUJsonValue
ScratchNativeRequestAdapterOptions           -> GPUNativeRequestAdapterOptions
ScratchPendingGpuOperation                   -> GPUPendingOperation
ScratchPendingGpuOperationKind               -> GPUPendingOperationKind
ScratchReadbackStagingReservation            -> GPUReadbackStagingReservation
ScratchResourceIdentity                      -> GPUResourceIdentity
ScratchRuntimeAuthorityObservation           -> GPURuntimeAuthorityObservation
ScratchRuntimeAuthorityStamp                 -> GPURuntimeAuthorityStamp
ScratchRuntimeAuthorityState                 -> GPURuntimeAuthorityState
ScratchRuntimeConstructorOptions             -> GPURuntimeConstructorOptions
ScratchRuntimeDiagnosticsController          -> GPURuntimeDiagnosticsController
ScratchRuntimeLifecycleChange                -> GPURuntimeLifecycleChange
ScratchRuntimePipelineRegistration           -> GPURuntimePipelineRegistration
ScratchRuntimeResourceFactBase               -> GPURuntimeResourceFactBase
ScratchSubmissionNativeObservationReservation -> GPUSubmissionNativeObservationReservation
'GpuOperation'                               -> 'GPUOperation'
```

These names are Scratch-wide and must not be GPU-prefixed:

```text
ScratchDiagnostic
ScratchDiagnosticBase
ScratchDiagnosticDomain
ScratchDiagnosticInput
ScratchDiagnosticReport
ScratchDiagnosticError
ScratchDiagnosticErrorContext
ScratchDiagnosticErrorOptions
ScratchDiagnosticSeverity
ScratchDiagnosticSubject
ScratchDiagnosticSuggestion
ScratchDiagnosticEvidence
```

`WorkerDiagnosticSeverity` is removed in favor of the shared `ScratchDiagnosticSeverity`; it is not retained as an alias. `WorkerDiagnostic`, `WorkerDiagnosticInput`, `WorkerDiagnosticCode`, `WorkerDiagnosticPhase`, `WorkerDiagnosticSubject`, `WorkerCancellationKind`, and `WorkerRemoteErrorFacts` remain Worker-domain contracts.

---

## Appendix B: Explicit Preserve And Delete Boundaries

### Preserve under Scratch

- Every current TypeScript GPU resource, layout codec, program, shader module, bind layout/set, pipeline, command, pass, submission, readback, query, surface, temporal texture, diagnostics and native observation capability.
- Every current Worker task/module/group/context/priority/cancellation/transfer/lifecycle capability.
- `plane` and `sphere`, with exact output parity.
- Internal UUID identity generation, without a public export.

### Preserve under Geo

- `MercatorCoordinate`.
- Coordinate domain and high-precision position codecs.
- Tile matrix and `WebMercatorQuad`.
- Virtual-raster addressing, sampling, demand, residency, transfer, GPU lowering and the current temporary virtual-raster cache.
- `GeoDiagnostic` as a separate Geo-domain contract.

### Delete

- Legacy global-device GPU API, `StartDash`, old Buffer/Texture/Binding/Pipeline/Pass, Director and Monitor.
- Effects and loaders.
- ArrayRef, BlockRef, numeric wrappers, ScratchObject and random helper.
- `GeoQuadNode2D`, `Node2D`, old quadtree and `BoundingBox2D`.
- Duplicate core Mercator source.
- Old geometry/worker public subpaths and forwarding source.
- All same-source JavaScript and handwritten declaration files.

---

## Completion Record Template

The final audit and user report must use this exact shape:

```text
Status: confirmed-clean | completed-with-findings
Goal-start: e43d162150070c1d0b0cb0d61e27ac027a98ab64
Final commit: output of `git rev-parse HEAD` at completion
Public exports: pass | finding
GPU one-to-one parity: pass | finding
Worker semantic parity: pass | finding
Unified diagnostics: pass | finding
TypeScript-only source: pass | finding
WebGPU/WGSL audit: pass | finding
Worker browser: pass | finding
Hello GAW browser: pass | finding
DEM browser: pass | finding
Flow browser: pass | finding
Findings: none | <command, cause, impact, next action>
```
