# GPU Resident Tile Frontier DEM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 GPU 持久 active frontier、视锥/SSE 选择、GPU 预算仲裁和 indirect dispatch/draw clean-cut 替换 DEM example 的 CPU 四叉树选择，同时保留高精度坐标、Virtual Raster、异步 worker streaming 与 mesh-stitching。

**Architecture:** `VirtualRasterGpuState` 在现有 page table/atlas publication 中增加通用 physical-slot reverse table；新的 Geo `GpuTileFrontier` 读取该表并以固定 Scratch submission graph 在 GPU 上维护 A/B frontier、产生 visible instances、page demands、diagnostics 和通用 indirect draw arguments。DEM 只提供 WebMercatorQuad 相机适配、高程范围、每级 geometric error、terrain shaders 与 draw templates，不在 Scratch 中引入 tile/terrain 语义。

**Tech Stack:** TypeScript 6、WGSL、WebGPU、GeoScratch Scratch primitives、MapLibre GL JS camera adapter、Mocha/Chai、Playwright headed Chrome、Python DEM COG tile server。

## Global Constraints

- 设计事实来源是 `docs/superpowers/specs/2026-08-06-gpu-resident-tile-frontier-dem-design.md`；实现不得扩展到 globe、Flow LoD、scene graph、material 或 GPU network access。
- Scratch core 不理解 tile、frustum、SSE、LoD、terrain、Virtual Raster policy；本计划不得修改 `packages/geoscratch/src/scratch/`，除非现有 Scratch 行为被可复现测试证明不符合已经公开的 indirect/readback 契约。
- 每帧 CPU selection 热路径只允许写一个 MapMeta upload、选择预创建的 A/B frame template 并提交固定图；不允许 CPU tree traversal、visible arrays、canonical-node packing 或 indirect count materialization。
- `matrixLevel` 表示 TileMatrixSet 从粗到细的顺序；`samplingLevel` 表示 Virtual Raster 从细到粗的内部 level。两个字段必须分别存储，不允许隐式换算或同名混用。
- GPU 写入后又作为 indirect 读取的 buffer usage 必须包含 `GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT`；CPU 不 map、decode 或 shadow indirect bytes。
- active frontier、hash、decision、scan、visible、demand、diagnostic 和 readback 均为固定容量；overflow 保留 parent cover 并产生结构化 Geo diagnostic。
- 当前 frontier 必须维持相邻 `matrixLevel` 差不超过 1；不依赖轮数不定的同帧 GPU fixpoint。
- page demand/readback 可以落后一至数帧；active parent 在 required covered children 全部 acknowledged 前不可退役。
- Virtual Raster 仍是通用栅格资源；DEM page-to-patch、高程误差和 mesh policy 不进入 `VirtualRasterGpuState` 的通用 slot ABI。
- 所有生产源码是 TypeScript/WGSL；examples 只从 `geoscratch`, `geoscratch/geo` 和 `geoscratch/scratch` 导入公开 API。
- 每个任务先得到预期 RED，再实现 GREEN，完成目标测试与 bounded diff review 后独立提交。
- 用户已有的 `AGENTS.md` 未提交修改不得暂存、覆盖或还原。

---

## File Structure

- `packages/geoscratch/src/geo/virtual-raster-gpu.ts`: 在现有 atlas/page-table publication 生命周期内维护 generic physical-slot reverse table。
- `packages/geoscratch/src/geo/virtual-raster-residency.ts`: 增加 owner-scoped、generation-safe residency lease，保护 GPU frontier 的 parent/child handoff。
- `packages/geoscratch/src/geo/virtual-raster-gpu-feedback.ts`: 三槽 bounded demand/retire/diagnostic readback ring。
- `packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts`: 定义 MapMeta、policy、slot/frontier/decision/demand/diagnostic/indirect ABI 与 codec 常量。
- `packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts`: 纯 CPU、确定性的测试 oracle；不进入 DEM production hot path。
- `packages/geoscratch/src/geo/gpu-tile-frontier-wgsl.ts`: 生成 WebMercatorQuad frontier 的固定 compute kernel module。
- `packages/geoscratch/src/geo/gpu-tile-frontier.ts`: 拥有 GPU resources、pipelines、commands、A/B frame templates、bounded readback 和 lifecycle。
- `packages/geoscratch/src/scratch/gpu/command.ts` and `submission.ts`: 仅补齐通用 ordered readback 的 `current-at-step` epoch 契约。
- `packages/geoscratch/src/geo/index.ts`: 只导出稳定的 Geo frontier API 和类型。
- `examples/demLayer/dem-virtual-raster.ts`: 把 GPU demand 转成现有 `VirtualRasterRequestScheduler` reconciliation，不再消费 CPU selection。
- `examples/demLayer/dem-layer.ts`: 组合 Geo frontier compute、LoD-map indirect draw、terrain indirect draw 与 residency publication。
- `examples/demLayer/dem-map.ts`: 生成单一 MapMeta 所需的 camera-relative matrix、high/low camera、FOV、viewport 和 zoom hint。
- `examples/demLayer/shaders/lod-map.wgsl`: 从 GPU visible instance tile address 绘制固定 source-domain LoD map。
- `examples/demLayer/shaders/terrain-mesh.wgsl`: 从 tile address + local grid 重建高精度 WebMercator 坐标，采样 Virtual Raster，并按 GPU 邻接 level stitching。
- `tests/fixtures/geo-gpu-tile-frontier.ts`: 真实 WebGPU synthetic frontier proof。
- `tests/browser/geo-gpu-tile-frontier-core.mjs`: CPU oracle、公开 feedback ring 与真实 GPU 输出的一对一 proof harness。
- `tests/browser/scratch-dem-layer.mjs`: DEM 高俯仰、bearing、teleport、tight budget、failure、resize 和 cleanup proof。
- `tests/browser/geo-virtual-raster-dem.mjs`: DEM demand/residency/cache/churn 的 GPU-frontier 版本 proof。
- `docs/decisions/ADR-061-gpu-resident-tile-frontier-dem.md`: 接受最终所有权与 clean-cut 决策。
- `docs/vision/geo-api/geoscratch-geo-api-vision-docs/05-tiles-lod-streaming-residency/README_zh.md`: 固化 GPU frontier 与现有 demand/residency 的所有权衔接。
- `docs/review/gpu-resident-tile-frontier-dem-final-audit.md`: 保存最终事实、命令、截图路径、提交与残余问题。

---

### Task 1: Fail-Closed Virtual Raster GPU Publication and Physical Slot Reverse Table

**Files:**
- Modify: `packages/geoscratch/src/geo/virtual-raster-gpu.ts`
- Modify: `packages/geoscratch/src/geo/virtual-raster.ts`
- Modify: `tests/geo-virtual-raster.test.js`
- Modify: `tests/scratch-persistent-binding-final-parity.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: `VirtualRasterPublication.snapshot`, `VirtualRasterPhysicalPage`, `TileMatrixCoverage.index()` 和现有 atlas/page-table acknowledgement。
- Produces: `VirtualRasterGpuState.slotTable: BufferResource`, `VirtualRasterGpuUpdate.slotTableUpload?: UploadCommand`, `VirtualRasterGpuFacts.slotTableBytes: number`, GPU-distinct `failed` page status, and native-outcome-gated publication acknowledgement。
- Slot ABI: 每个物理槽固定 12 个 `u32`：`valid, samplingLevel, matrixLevel, tileRow, tileCol, compactIndex, physicalSlot, generation, contentEpoch, snapshotEpoch, publicationEpoch, flags`。非 tile address 的 `matrixLevel/tileRow/tileCol/compactIndex` 写 `0xffffffff`。DEM 的 minimum/maximum elevation 与 geometric error 由 Geo frontier 的 level-metric buffer 提供，不进入通用 Virtual Raster slot ABI；compute 读取两者后形成设计文档所称的完整 resident-slot evaluation facts。

- [ ] **Step 1: Write the failing slot-table publication test**

在 `tests/geo-virtual-raster.test.js` 的 GPU-state describe 中扩展 publication test：

```js
expect(gpuState.slotTable).to.exist
expect(update.slotTableUpload).to.exist
expect(update.commands).to.have.length(4)
expect(gpuState.facts()).to.deep.include({
    slotTableBytes: 2 * 12 * Uint32Array.BYTES_PER_ELEMENT,
})
expect(update.commands.at(-1)).to.equal(update.slotTableUpload)
```

再使用 fake queue write bytes 断言两个 occupied slots 的 `valid/generation/contentEpoch/snapshotEpoch`，并断言 publication eviction 后被释放槽的 12 words 全为零。

同一 test block 还必须锁定：terminal `failed` page 即使没有 physical slot，page-table status 仍编码为 `4` 而不是全零 `missing`。包含本 publication upload command 的 changed publication 仅在 `submitted.nativeOutcome.status === 'observed-succeeded'` 时推进 acknowledged epoch；`observed-failed`、`observation-failed` 或 `unobserved` 必须保持 staged state 且不释放 staging bytes。无 upload、无 staging bytes、snapshot epoch 已经是当前 acknowledged epoch 的 unchanged publication 不归因于 submission 中的其他 native work，因此在同 runtime/command-membership 验证后直接 settle；既不要求整个 submission 是 `no-native-work`，也不让无关 draw failure阻塞这个 no-op settlement。

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster.test.js --grep "stable Scratch atlas/page-table resources"
```

Expected: FAIL because slot metadata does not exist, failed collapses to missing, and acknowledgement currently advances without checking native outcome.

- [ ] **Step 3: Add the stable slot resource and encoder**

在 `virtual-raster-gpu.ts` 增加固定布局和 encoder：

```ts
const SLOT_TABLE_WORDS = 12
const SLOT_INVALID = 0xffff_ffff

function encodeSlotTable(
    target: Uint32Array<ArrayBuffer>,
    snapshot: VirtualRasterSnapshot,
    maxPhysicalPages: number
): void
```

`VirtualRasterGpuState.create()` 同 atlas/page table 一次性创建 `slotTable` 和稳定 `UploadCommand`。`stage()` 每次 snapshot epoch 变化时从 `physicalPagesForSnapshot(snapshot)` 按物理槽排序编码，并把 slot upload 放在 page-table upload 后。`acknowledge()` 要求该 upload command id 存在于同一 `SubmittedWork`；`dispose()` 释放 upload 与 buffer。

`#encodePageTable()` 不再跳过 terminal failure：写 status `4`、requested/resolved level、snapshot epoch 与无效 slot sentinel。`VirtualRasterSampleStatus` 增加 `failed`；`VirtualRasterAccessor.wgslModule()` 在 page-table/sample status `4` 时返回 distinct failed sample，不允许把它当 atlas slot、missing 或现有 status `3` 的 no-data。

Changed publication 的 `acknowledge()` 在任何 residency mutation 前 `await submitted.nativeOutcome`，按前述规则 fail closed；失败诊断包含 submission id、snapshot epoch 和 native outcome。失败路径由调用方显式 `abandon(publication)` 或重试，不得暗中 acknowledge。Unchanged publication 不等待或继承不相关 native work 的成败。

- [ ] **Step 4: Keep non-tile Virtual Raster generic**

为普通 2D address-space fixture 增加断言：slot 仍合法，但四个 tile-only words 为 `SLOT_INVALID`。编码函数不得访问 DEM、高程、SSE 或 WebMercator 常量。

- [ ] **Step 5: Add public type usage and run GREEN**

在 `tests/types/public-api.ts` 加入：

```ts
declare const typedRasterGpuState: VirtualRasterGpuState
const typedSlotTable: scr.BufferResource = typedRasterGpuState.slotTable
const typedSlotBytes: number = typedRasterGpuState.facts().slotTableBytes
void typedSlotTable
void typedSlotBytes
```

Run:

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster.test.js
npm run typecheck
git diff --check
```

Update the intentional declaration-signature count in `tests/scratch-persistent-binding-final-parity.test.js` for the three new public declarations, then run the full suite. Expected: all commands PASS; fake queue writes show atlas uploads plus exactly two stable buffer uploads when a snapshot changes.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/geoscratch/src/geo/virtual-raster-gpu.ts packages/geoscratch/src/geo/virtual-raster.ts tests/geo-virtual-raster.test.js tests/scratch-persistent-binding-final-parity.test.js tests/types/public-api.ts
git commit -m "Expose virtual raster GPU slot metadata"
```

---

### Task 2: Geo Frontier Contracts, Layouts, Diagnostics, and CPU Oracle

**Files:**
- Create: `packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts`
- Create: `packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts`
- Create: `tests/geo-gpu-tile-frontier.test.js`
- Modify: `packages/geoscratch/src/geo/diagnostics.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: `VirtualRasterAddressSpace`, `VirtualRasterGpuState`, `VirtualRasterPageIdentity`, `WebMercatorQuadAddressCodec`, Scratch `LayoutCodec` artifacts。
- Produces public types `GpuTileFrontierPolicy`, `GpuTileFrontierView`, `GpuTileFrontierLevelMetric`, `GpuTileFrontierDrawTemplate`, `GpuTileFrontierDescriptor`, `GpuTileFrontierDemand`, `GpuTileFrontierFacts` and factory `gpuTileFrontierPolicy()`。
- Produces package-internal `evaluateGpuTileFrontierReference(input)` with the same retain/refine/coarsen/balance/budget rules as WGSL。

- [ ] **Step 1: Write RED tests for policy and deterministic reference behavior**

`tests/geo-gpu-tile-frontier.test.js` must cover these exact cases:

```js
const invalidPolicy = {
    refineErrorPixels: 2,
    coarsenErrorPixels: 2,
    minimumMatrixLevel: 0,
    maximumMatrixLevel: 3,
    maximumActiveTiles: 16,
    maximumDemands: 8,
    transitionReservePages: 5,
    invisibleGraceFrames: 2,
}

expect(() => gpuTileFrontierPolicy(invalidPolicy)).to.throw(GeoDiagnosticError)

try {
    gpuTileFrontierPolicy(invalidPolicy)
    expect.fail('invalid frontier policy should throw')
} catch (error) {
    expect(error).to.be.instanceOf(GeoDiagnosticError)
    expect(error.diagnostic.code).to.equal('GEO_GPU_TILE_FRONTIER_INVALID')
}
```

Reference fixtures then assert: an off-frustum leaf is not visible; an under-threshold leaf retains; a refine candidate without all covered children keeps its parent and emits canonical child demands; acknowledged children replace parent; an unsafe level-difference transition is rejected; coarsen requires the canonical sibling group; priority bucket ties resolve by hierarchical path-prefix frontier order; tight capacity preserves a complete parent cover.

Discovered-design correction for Task 3B: numeric `compactIndex` order is address identity, not canonical array order. Canonical frontier/demand/tie order is maximum-level-aligned hierarchical path-prefix order with row bit before column bit (`00, 01, 10, 11`). A valid frontier is prefix-free; stable parent-to-children replacement and complete sibling-to-parent coarsening therefore preserve this order in `O(active)` without global atomics, per-output rank rescans, or radix passes. Mixed-level and subcoverage fixtures must lock this invariant.

- [ ] **Step 2: Run RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-gpu-tile-frontier.test.js
```

Expected: FAIL with missing module/exports.

- [ ] **Step 3: Define exact public contracts and codecs**

`gpu-tile-frontier-layout.ts` defines these stable inputs:

```ts
export type GpuTileFrontierView = Readonly<{
    clipFromRelativeWorld: ArrayLike<number>
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    viewport: readonly [number, number]
    verticalFovRadians: number
    cameraLatitudeRadians: number
    zoomHint: number
    frameEpoch: number
    residencySnapshotEpoch: number
}>

export type GpuTileFrontierLevelMetric = Readonly<{
    matrixLevel: number
    minimumElevationMeters: number
    maximumElevationMeters: number
    geometricErrorMeters: number
}>

export type GpuTileFrontierDrawTemplate = Readonly<{
    id: string
    vertexCount: number
    firstVertex?: number
    firstInstance?: number
}>
```

MapMeta、policy、level metric、frontier entry、visible instance、demand 和 diagnostics 都由 `layoutCodec()` 建立；导出 byte sizes/field offsets 给 TypeScript packer 和 WGSL generator 共用，禁止手写两份偏移。

- [ ] **Step 4: Implement structured policy validation**

给 `GeoDiagnosticPhase` 增加 `'selection'`。`gpuTileFrontierPolicy()` 验证 finite numbers、`coarsenErrorPixels < refineErrorPixels`、level order、positive capacities 和 `maximumDemands <= maximumActiveTiles * 4`；`GpuTileFrontier.create()` 再依据传入的 slot capacity 验证 transition reserve。失败 codes 使用已批准的 `GEO_GPU_TILE_*` envelope。

- [ ] **Step 5: Implement the CPU oracle**

`evaluateGpuTileFrontierReference()` 仅操作传入的有限 current frontier/resident-page records：

```ts
type GpuTileFrontierReferenceOutput = Readonly<{
    nextFrontier: readonly GpuTileFrontierReferenceEntry[]
    visible: readonly GpuTileFrontierReferenceEntry[]
    demands: readonly GpuTileFrontierDemand[]
    facts: GpuTileFrontierFacts
}>
```

实现顺序固定为 visibility/SSE candidate、256-bucket budget、refine acceptance、coarsen sibling transaction、neighbor balance validation、canonical prefix compaction。该模块不得创建 runtime、buffer、worker 或 network request。

- [ ] **Step 6: Export contracts and typecheck them**

在 `geo/index.ts` 导出 public contracts/factory，不导出 reference evaluator。在 `tests/types/public-api.ts` 构造完整 descriptor，并用 `@ts-expect-error` 锁定缺失 WebMercator projection、错误 tuple 长度和非法字段类型；重复 draw id 属于值级不变量，在 `geo-gpu-tile-frontier.test.js` 中断言结构化 runtime validation，而不伪装成 TypeScript 可判定错误。

- [ ] **Step 7: Run GREEN and commit Task 2**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-gpu-tile-frontier.test.js
npm run typecheck
git diff --check
git add packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts packages/geoscratch/src/geo/diagnostics.ts packages/geoscratch/src/geo/index.ts tests/geo-gpu-tile-frontier.test.js tests/types/public-api.ts
git commit -m "Define GPU tile frontier contracts"
```

Expected: policy/reference/type tests PASS and no Scratch source changes exist.

---

### Task 3: Ordered GPU-Produced Readback, Frontier Resources, Kernels, and Synthetic Proof

**Files:**
- Modify: `packages/geoscratch/src/scratch/gpu/command.ts`
- Modify: `packages/geoscratch/src/scratch/gpu/submission.ts`
- Create: `packages/geoscratch/src/geo/gpu-tile-frontier-wgsl.ts`
- Create: `packages/geoscratch/src/geo/gpu-tile-frontier.ts`
- Create: `packages/geoscratch/src/geo/virtual-raster-gpu-feedback.ts`
- Create: `tests/scratch-readback-current-content.test.js`
- Create: `tests/geo-virtual-raster-gpu-feedback.test.js`
- Create: `tests/fixtures/geo-gpu-tile-frontier.ts`
- Create: `tests/browser/geo-gpu-tile-frontier-core.mjs`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/geo-gpu-tile-frontier.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: Task 1 `slotTable`, Task 2 codecs/policy, Scratch compute/render/readback/SubmissionBuilder primitives；first closes the generic ordered-readback gap proven by RED without adding any Geo semantics to Scratch。
- Produces `GpuTileFrontier.create(runtime, descriptor)`, `stageSeed(snapshot)`, `writeView(view)`, `frame(viewToken)`, `encode(builder, frame)`, `drawArgument(frame, id)`, `facts()`, and `dispose()`。`writeView()` returns an immutable, explicitly disposable token; `encode()` adds the token's private MapMeta upload and the selected private 12-command template while attaching residency/view submission requirements。
- `frame()` exposes only the A/B-matched visible-instance source, immutable ids/facts, and draw-argument capability. Task 3C separately adds `VirtualRasterGpuFeedbackRing`, owns the three bounded readback slots, and decodes demands, generation-safe retirements, counters, and diagnostics。

Discovered API correction: a frame assembled before either residency acknowledgement or a newer `writeView()` must fail at submission, so raw `viewUpload`, compute pass, command arrays, working buffers, and feedback write regions are not Geo frame capabilities. Scratch command/resource descriptors remain an intentional expert escape hatch for direct GPU composition, not a same-realm security boundary。

- [ ] **Step 1: Prove the generic ordered-readback gap with RED**

Create `tests/scratch-readback-current-content.test.js`. A persistent readback command with:

```js
source: { region: gpuProducedRegion, contentEpoch: 'current-at-step' }
```

must be reusable across at least three submissions where an earlier compute command writes a new epoch. The test asserts each operation reads that submission's producer epoch, `SubmittedWork.resourceAccesses` preserves declared `'current-at-step'` plus the resolved numeric epoch, a readback placed before its producer fails without lookahead, and indeterminate prior content still fails closed.

Run:

```bash
npm --workspace geoscratch run build
npx mocha tests/scratch-readback-current-content.test.js
```

Expected: RED with `SCRATCH_READBACK_SOURCE_INVALID` because `ReadbackCommandDescriptor` currently accepts only a numeric epoch.

- [ ] **Step 2: Add `current-at-step` to ordered readback without weakening CopyCommand**

Define a readback-only source descriptor whose `contentEpoch` is `CommandResourceReadEpoch`; keep ordinary `BufferCopyCommandSourceDescriptor` numeric. Normalize `'current-at-step'`, pass it through readiness simulation, and at the readback step snapshot the actual simulated/produced numeric epoch into the claim, operation and `SubmittedWork` provenance. Do not permit future lookahead, stale numeric reads or indeterminate reads.

- [ ] **Step 3: Run Scratch readback gates and commit the generic prerequisite**

```bash
npm --workspace geoscratch run build
npx mocha tests/scratch-readback-current-content.test.js tests/scratch-readback-command.test.js tests/scratch-native-indirect-execution.test.js
npm run typecheck
git diff --check
git add packages/geoscratch/src/scratch/gpu/command.ts packages/geoscratch/src/scratch/gpu/submission.ts tests/scratch-readback-current-content.test.js tests/types/public-api.ts
git commit -m "Allow ordered readback of current GPU content"
```

Expected: all PASS; the Scratch diff contains only the generic epoch contract and no tile/frontier term.

- [ ] **Step 4: Extend frontier unit tests with RED resource-graph assertions**

Create a fake-GPU fixture and assert:

```js
const frontier = await GpuTileFrontier.create(runtime, descriptor)
const evenView = frontier.writeView(view0)
const evenFrame = frontier.frame(evenView)
const terrainArguments = frontier.drawArgument(evenFrame, 'terrain')
expect(terrainArguments.resource.usage & GPU_BUFFER_USAGE_STORAGE).to.not.equal(0)
expect(terrainArguments.resource.usage & GPU_BUFFER_USAGE_INDIRECT).to.not.equal(0)
const access = gpuTileFrontierTestFrameAccess(frontier, evenFrame)
expect(access.commands.map(command => command.label)).to.deep.equal([
    'Reset GPU tile frontier',
    'Clear GPU tile frontier lookup',
    'Build GPU tile frontier lookup',
    'Evaluate GPU tile frontier',
    'Select GPU tile frontier budgets',
    'Resolve GPU tile frontier transitions',
    'Balance GPU tile frontier neighbors',
    'Scan GPU tile frontier blocks',
    'Scan GPU tile frontier block sums',
    'Add GPU tile frontier scan offsets',
    'Compact GPU tile frontier outputs',
    'Finalize GPU tile frontier arguments',
])
const submitted = frontier.encode(runtime.createSubmission(), evenFrame).submit()
evenView.dispose()
```

Assert the first issued frontier frame reads A/writes B and the next issued frontier frame reads B/writes A regardless of caller `frameEpoch`; cancelled tokens, unsubmitted builders, and failures before the frontier issue boundary do not advance parity. A later composed queue action may make `submit()` throw after frontier issue, but must not roll parity back. Object ids remain stable, stale view/residency/sequence stamps fail at submission, and no `mapAsync` or direct native buffer read occurs.

- [ ] **Step 5: Run frontier unit RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-gpu-tile-frontier.test.js --grep "GPU resource graph"
```

Expected: FAIL because `GpuTileFrontier` does not exist.

- [ ] **Step 6: Generate the fixed WGSL command graph**

`gpu-tile-frontier-wgsl.ts` emits named entry points with one shared ABI module:

```text
resetFrontier
clearLookup
buildLookup
evaluateFrontier
selectBudgets
resolveTransitions
balanceNeighbors
scanBlocks
scanBlockSums
addScanOffsets
compactOutputs
finalizeArguments
```

Requirements encoded in WGSL:

- reconstruct normalized WebMercator tile bounds from `matrixLevel/tileRow/tileCol`;
- subtract high/low camera origin before clip projection;
- derive conservative vertical extent from level metrics expressed in meter-space elevation units;
- use six extracted frustum planes and distance-to-AABB SSE;
- keep 256 deterministic priority buckets and hierarchical path-prefix tie order;
- use an epoch-tagged open-addressed current-frontier lookup with duplicate-key diagnostic;
- accept only complete covered-child transitions and canonical sibling coarsen transactions;
- reject transitions that would violate level difference 1;
- perform two-level stable prefix scan and canonical compaction;
- clamp every count and set overflow bits before writing indirect arguments.

- [ ] **Step 7: Implement persistent resources and A/B templates**

`GpuTileFrontier.create()` allocates all buffers once. `stageSeed(snapshot)` resolves configured roots against the acknowledged snapshot and initializes frontier A plus dispatch A. `writeView()` is the sole per-frame CPU pack, advances the bounded view submission authority once, and captures the current frontier-sequence stamp. `frame(viewToken)` chooses one of two precreated compute/render resource templates from that issued-frontier sequence; caller `frameEpoch` remains decision metadata and never controls A/B state. `encode(builder, frame)` validates ownership/liveness, adds the captured residency/view requirements, appends the private immutable MapMeta upload and exact private compute template, then places `consume(sequenceStamp)` immediately after that work as an ordered issue boundary. Failure before this boundary consumes nothing; failure in later composed work cannot replay the already-issued A/B transition. The caller disposes the view token after submission. Task 3C owns readback-slot selection and backpressure.

Each A/B draw-argument buffer contains one 16-byte region per `GpuTileFrontierDrawTemplate`. `finalizeArguments` writes static `vertexCount/firstVertex/firstInstance` plus GPU visible count into the region matched to the frame's visible buffer. `VirtualRasterGpuFeedbackRing` owns exactly three persistent `ReadbackCommand` slots with `retain: 'consume-on-read'` and one private issue authority. `encode(builder, frame)` requires the package-private exact-frame marker written by one successful `GpuTileFrontier.encode()` plus exactly one matching upload/compute graph; busy submitted-slot backpressure fails before builder mutation, while speculative open builders remain authority-arbitrated contenders rather than hidden reservations. `feedback(frame, submitted)` uses exact `SubmittedWork` provenance and actual successful frontier issue sequence, not caller `frameEpoch`, to enforce N-1-or-earlier consumption. It consumes the selected operation once, validates packed decision and current acknowledged residency epochs, canonicalizes demands, rejects every counter above fixed capacity, requires exact resident demand parents, and accepts retirements only when exact resident page, physical slot, generation, content epoch, and snapshot epoch still match. Public batches expose immutable domain facts, never raw mapped bytes or history. Direct JS construction and public identity rebinding are rejected; frontier disposal cascades to all three commands and the private authority.

- [ ] **Step 8: Prove same-submission provenance with fake GPU**

Submit seed, MapMeta upload, compute commands, and a small indirect draw. Assert `SubmittedWork.resourceAccesses` reports `current-at-step` reads for internally produced dispatch arguments and each draw argument; producer and consumer epochs match; `fake.calls.maps` remains empty; overflow/zero-work still records producer epochs without CPU fallback.

- [ ] **Step 9: Add the real-browser synthetic fixture**

`tests/fixtures/geo-gpu-tile-frontier.ts` creates a finite WebMercatorQuad z0-z3 coverage, synthetic resident snapshots, and these proofs:

1. all children resident: four frames converge from root to expected visible descendants;
2. children missing: parent remains visible and canonical demands are returned;
3. tight active budget: result matches CPU oracle and remains complete;
4. off-axis/high-pitch matrix: near tiles refine, far tiles coarsen, outside-frustum tiles are absent from visible output;
5. identical seed/view run twice: visible/demand order and indirect words are byte-identical;
6. stale generation: stale entry is not drawn and increments diagnostic count.

`geo-virtual-raster-gpu-feedback.test.js` separately asserts N-1-or-earlier consumption, submitted-slot backpressure, speculative-builder authority arbitration, exact encode provenance, all bounded counter limits, stale decision/snapshot rejection, exact-resident versus fallback authority, canonical demand dedupe, generation-matched retire decoding, runtime construction closure, and immutable ownership identity. It must never return raw mapped bytes or an unbounded history.

- [ ] **Step 10: Run real GPU RED then GREEN**

Before implementation, run the new browser harness and record missing export RED. After implementation run:

```bash
node tests/browser/geo-gpu-tile-frontier-core.mjs
```

Expected GREEN JSON: `status: "passed"`, CPU/GPU comparisons all true, validation/uncaptured/console/page errors empty, and managed Chrome/Vite ports closed.

- [ ] **Step 11: Run Task 3 frontier gates and commit**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-gpu-tile-frontier.test.js tests/geo-virtual-raster.test.js tests/geo-virtual-raster-gpu-feedback.test.js tests/scratch-native-indirect-execution.test.js
npm run typecheck
node tests/browser/geo-gpu-tile-frontier-core.mjs
git diff --check
git add packages/geoscratch/src/geo/gpu-tile-frontier-wgsl.ts packages/geoscratch/src/geo/gpu-tile-frontier.ts packages/geoscratch/src/geo/virtual-raster-gpu-feedback.ts packages/geoscratch/src/geo/index.ts tests/geo-gpu-tile-frontier.test.js tests/geo-virtual-raster-gpu-feedback.test.js tests/types/public-api.ts tests/fixtures/geo-gpu-tile-frontier.ts tests/browser/geo-gpu-tile-frontier-core.mjs
git commit -m "Implement GPU tile frontier execution"
```

---

### Task 4: Route GPU Demand into DEM Virtual Raster Streaming

**Files:**
- Modify: `packages/geoscratch/src/geo/virtual-raster-residency.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/dem-virtual-raster.ts`
- Modify: `tests/geo-virtual-raster.test.js`
- Modify: `tests/geo-virtual-raster-ownership.test.js`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`

**Interfaces:**
- Consumes: `VirtualRasterGpuFeedbackBatch`, current `VirtualRasterRequestScheduler`, existing worker executor/cache/residency publication。
- Produces `VirtualRasterResidencyLease`, and `reconcileFeedback(feedback)` returning `{ generation, requestedCount, retainedCount, retiredCount, settlement }`。
- Removes production `prepare(selection)` and `planDemVirtualPages()` from the DEM runtime contract。

- [ ] **Step 1: Rewrite tests to RED against GPU demand reconciliation**

Tests construct feedback batches with demands carrying `page`, `priority`, `decisionEpoch`, `parentPage/parentGeneration` and `required` flags plus retire records carrying `page/generation`, then assert:

```js
const first = virtualRaster.reconcileFeedback(feedbackAt(7, demands, []))
expect(first.requestedCount).to.equal(coveredMissingPages.length)
const second = virtualRaster.reconcileFeedback(feedbackAt(8, [], retirements))
expect(second.generation).to.be.greaterThan(first.generation)
expect(virtualRaster.scheduler.inspect().activeRequestCount).to.equal(0)
```

Also assert every minimum-matrix safety-cover page remains leased, duplicate demand keys collapse to highest priority, out-of-coverage pages produce `GEO_GPU_TILE_FRONTIER_INVALID`, and stale decision epochs cannot revive canceled work. A demanded transition leases its resident parent and each newly installed child; only a generation-matched GPU retire releases a lease. A stale retire, failed upload acknowledgement, pending child set or disposed feedback slot cannot make an active page evictable.

- [ ] **Step 2: Run RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster-dem.test.js tests/scratch-dem-layer-clean-cut.test.js --grep "GPU demand"
```

Expected: FAIL because runtime exposes only `prepare(selection)` and residency has no owner-scoped generation-safe lease.

- [ ] **Step 3: Implement owner-scoped residency leases**

`VirtualRasterResidency.createLease({ id, maximumPages })` returns an explicit `VirtualRasterResidencyLease` with `retain(page, generation)`, `release(page, generation)`, `facts()` and idempotent `dispose()`. Residency eviction excludes a page only while a live lease contains that page's current physical-slot generation; stale generations cannot protect a reused slot or release its replacement. The lease has a hard page budget, bounded facts/history, structured overflow diagnostics, and is independent of request/cache/worker state. Existing manual `pin/unpin` remains source-owned safety policy, not transition authority.

Add tests for two independent owners, stale release after slot reuse, lease overflow, publication abandon, and dispose. No GPU or DEM term enters the residency API.

- [ ] **Step 4: Implement the event-path adapter**

Replace selection planning with:

```ts
function reconcileFeedback(
    feedback: VirtualRasterGpuFeedbackBatch
) {
    const demandGeneration = ++generation
    const requested = canonicalDemands(model, feedback, demandGeneration)
    const leaseChanges = applyTransitionLeases(
        residencyLease,
        feedback,
        residency.currentSnapshot
    )
    const reconciliation = scheduler.reconcile(virtualRasterDemandSet({
        generation: demandGeneration,
        demands: [
            ...model.safetyCoverPages.map(page => rootDemand(page, demandGeneration)),
            ...requested,
        ],
    }))
    return Object.freeze({
        generation: demandGeneration,
        requestedCount: reconciliation.requestedCount,
        retainedCount: leaseChanges.retainedCount,
        retiredCount: leaseChanges.retiredCount,
        settlement: reconciliation.settled,
    })
}
```

`safetyCoverPages` is every covered tile in the coarsest configured matrix, not `VirtualRasterAddressSpace.rootPage()`'s single top-left convenience page. Priority mapping preserves GPU score and usage (`required`/`prefetch`) without recomputing camera distance. CPU scheduler remains authority for worker cancellation, cache, network/decode budgets and terminal failure publication. Publication install leases acknowledged children before they can enter a GPU frontier; GPU retire releases old parent/children only after the replacement cover is visible in a later acknowledged snapshot. Dispose releases the frontier lease after in-flight SubmittedWork settles.

- [ ] **Step 5: Remove selection-shaped production exports**

Delete `TerrainSelection`, `DemVirtualRasterPagePlan`, `planDemVirtualPages`, `comparePagesForCamera`, selection-to-bounds loops and `MAX_TERRAIN_NODES` import from `dem-virtual-raster.ts`. Keep coordinate/sampling/stitch helpers used by shaders/tests.

- [ ] **Step 6: Run GREEN and commit Task 4**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster.test.js tests/geo-virtual-raster-ownership.test.js tests/geo-virtual-raster-dem.test.js tests/geo-virtual-raster-demand.test.js tests/geo-virtual-raster-gpu-feedback.test.js tests/scratch-dem-layer-clean-cut.test.js
npm --workspace examples run typecheck
git diff --check
git add packages/geoscratch/src/geo/virtual-raster-residency.ts packages/geoscratch/src/geo/index.ts examples/demLayer/dem-virtual-raster.ts tests/geo-virtual-raster.test.js tests/geo-virtual-raster-ownership.test.js tests/geo-virtual-raster-dem.test.js tests/scratch-dem-layer-clean-cut.test.js
git commit -m "Route DEM streaming from GPU demand"
```

Expected: scheduler/residency/cache tests PASS and no production code consumes `nodeLevels/nodeBoxes`.

---

### Task 5: Clean-Cut DEM Rendering onto the GPU Frontier

**Files:**
- Modify: `examples/demLayer/dem-map.ts`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `examples/demLayer/main.ts`
- Modify: `examples/demLayer/shaders/lod-map.wgsl`
- Modify: `examples/demLayer/shaders/terrain-mesh.wgsl`
- Modify: `examples/demLayer/dem-virtual-raster.ts`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Modify: `tests/examples-structure.test.js`

**Interfaces:**
- Consumes: Task 3 `GpuTileFrontier`, Task 4 `reconcileDemands`, existing MapLibre transform and DEM Virtual Raster WGSL sampler。
- Produces frame order `MapMeta upload -> residency uploads -> frontier compute -> LoD drawIndirect -> terrain drawIndirect -> demand readback`。
- Removes `selectTerrainNodes`, node buffers, canonical-node buffers, camera-coordinate buffer and CPU indirect uploads from the production graph。

- [ ] **Step 1: Make clean-cut source tests RED**

Replace old CPU-selection snapshots with source/contract assertions:

```js
expect(layerSource).to.include('GpuTileFrontier.create(')
expect(layerSource).to.include('frontier.encode(builder, frame)')
expect(layerSource).to.include('feedbackRing.encode(builder, frame)')
expect(layerSource).to.not.match(/selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes/)
expect(layerSource).to.not.match(/lodArguments\.upload|terrainArguments\.upload/)
expect(contract.countPath).to.equal('gpu-produced-indirect-arguments')
expect(contract.selectionPath).to.equal('gpu-resident-active-frontier')
```

Run the focused tests and confirm they fail against the current CPU implementation.

- [ ] **Step 2: Extend the MapLibre camera adapter**

`readDemCameraState()` returns exactly the Task 2 `GpuTileFrontierView` fields plus `far/near` required by terrain color/depth. Compute `verticalFovRadians` from `_fov/fov`, preserve the current `f64 -> high/low` split, and keep `clipFromRelativeWorld = absoluteClipMatrix * translate(cameraHigh)` so shaders consume camera-relative coordinates.

- [ ] **Step 3: Create frontier policy and level metrics from manifest facts**

For every covered TileMatrixSet matrix, derive:

```ts
const geometricErrorMeters = matrix.cellSize * matrix.tileWidth / TERRAIN_SECTOR_SIZE
```

Use manifest elevation range and `TERRAIN_EXAGGERATION` for conservative vertical bounds. Configure root pages from the minimum matrix coverage, `maximumActiveTiles <= coverage.entryCount`, `maximumDemands <= maxPhysicalPages * 4`, and `transitionReservePages >= maximum covered child count + 1` when the physical-page budget permits. Tight budgets reject refine and report budget-limited instead of creating holes.

- [ ] **Step 4: Replace DEM frame construction**

`renderFrame(camera)` performs no selection. It stages current residency publication, writes MapMeta once, gets the A/B frontier frame, and submits residency uploads before compute when and only when publication changed:

```ts
const viewToken = frontier.writeView(camera)
const frame = frontier.frame(viewToken)
try {
    for (const upload of residency.commands) builder.upload(upload)
    frontier.encode(builder, frame)
    builder
        .render(passes.lodMap, [ commands.drawLodMap ])
        .render(passes.terrain, [ commands.drawTerrain ])
    feedbackRing.encode(builder, frame)
    const submitted = builder.submit()
    // Acknowledgement and feedback decode remain asynchronous from submitted.
} finally {
    viewToken.dispose()
}
```

After submission, publication acknowledgement and feedback decode run asynchronously. Decoded demands/retirements call `virtualRaster.reconcileFeedback`; request settlement schedules another frame. While frontier facts are `seeding`, `refining`, `coarsening` or `waiting-residency`, `main.ts` schedules bounded follow-up frames even if MapLibre camera is static.

- [ ] **Step 5: Rewrite LoD-map shader inputs**

`lod-map.wgsl` reads `visibleInstances` entries containing `matrixLevel`, `tileRow`, `tileCol`, `samplingLevel`, physical slot/generation and four neighbor matrix levels. It reconstructs normalized WebMercator tile bounds, maps them into the fixed DEM source projected bounds, and writes matrix level. No CPU `tileBox`, `sectorRange`, `level[]` or `box[]` storage remains.

- [ ] **Step 6: Rewrite terrain vertex coordinates and stitching**

`terrain-mesh.wgsl` reads the same visible entry. It constructs exact wide-fixed WebMercator quanta from `(matrixLevel, tileRow, tileCol, local grid)` using integer shifts, samples `DemHeight_sample_vertex_mercator(position, samplingLevel)`, computes camera-relative XY from fixed-axis difference, and reads neighbor levels directly for 64-sector stitching. It does not reconstruct a seven-field address per vertex in memory and does not use global `f32` world coordinates as position truth.

- [ ] **Step 7: Update DEM provenance and lifecycle facts**

Provenance pairs become compute-produced `visibleInstances/indirectArgs -> render reads`, LoD-map pass -> terrain read, and optional residency slot/page-table uploads -> compute/terrain reads. State facts expose bounded counters only: frontier/visible/demand/fallback/stale/budget-limited counts, level range, maximum SSE, convergence and readback in-flight count.

- [ ] **Step 8: Run focused GREEN and commit Task 5**

```bash
npm --workspace geoscratch run build
npx mocha tests/scratch-dem-layer-clean-cut.test.js tests/examples-structure.test.js tests/geo-virtual-raster-dem.test.js
npm --workspace examples run typecheck
npm run build
git diff --check
git add examples/demLayer/dem-map.ts examples/demLayer/dem-layer.ts examples/demLayer/main.ts examples/demLayer/dem-virtual-raster.ts examples/demLayer/shaders/lod-map.wgsl examples/demLayer/shaders/terrain-mesh.wgsl tests/scratch-dem-layer-clean-cut.test.js tests/examples-structure.test.js tests/geo-virtual-raster-dem.test.js
git commit -m "Migrate DEM rendering to GPU tile frontier"
```

Expected: focused tests/typecheck/build PASS; production DEM source contains no CPU selector or CPU indirect count upload.

---

### Task 6: Browser Convergence, High-Pitch Visual Proof, and Failure Gates

**Files:**
- Modify: `tests/browser/scratch-dem-layer.mjs`
- Modify: `tests/browser/geo-virtual-raster-dem.mjs`
- Modify: `examples/demLayer/main.ts`

**Interfaces:**
- Consumes: bounded frontier facts/capture, DEM proof controller, tile-server delay/failure routing。
- Produces machine-readable browser evidence for pitch/bearing/teleport/convergence/parent fallback/tight budget/cache/lifecycle。

- [ ] **Step 1: Replace legacy visible-node expectations with GPU facts**

Remove hard-coded old counts `24/56/146` and `nodeLevels/nodeBoxes`. Require:

```js
if (facts.selectionPath !== 'gpu-resident-active-frontier') failures.push('wrong selection path')
if (facts.countPath !== 'gpu-produced-indirect-arguments') failures.push('wrong count path')
if (facts.cpuSelectionUploadCount !== 0) failures.push('CPU selection uploads remain')
if (!facts.frontierConverged) failures.push('frontier did not converge')
```

- [ ] **Step 2: Add deterministic camera scenarios**

For pitch `0, 45, 70, 85`, bearing `0, 90, 225`, and two zooms, move camera, wait until `convergence === "stable"` for three consecutive frames with identical `frontierHash/renderCoverHash` and `demandCount === 0`, capture canvas/frontier facts, and assert:

- every visible tile intersects the conservative frustum capture;
- near-screen matrix levels are not coarser than far-screen levels at equal geometric error;
- visible count equals both LoD and terrain indirect instance counts;
- maximum adjacent level delta is at most 1;
- repeated identical camera produces byte-identical bounded capture order;
- console warnings/errors, page errors, validation errors and unhandled rejections are empty.

The proof controller also renders a proof-only coverage/status mask into an offscreen target. Erode the asserted safety domain by two pixels, then require `coverageGapPixels === 0`, `invalidStatusPixels === 0`, `staleStatusPixels === 0`, and valid terrain coverage in near/middle/far screen bands for pitch 70/85. This mask is test-only and never changes the visible example pipeline.

- [ ] **Step 3: Add delayed residency and teleport proof**

Delay tile responses by 150 ms, teleport west/east, and assert current parent remains drawn until covered children become acknowledged. Old demands must be canceled or lose priority, demand count remains within capacity, and convergence resumes after responses are released.

- [ ] **Step 4: Add tight-budget and terminal-failure proof**

Run `atlasPages=2` and a routed child 404. Assert `budgetLimitedCount > 0` or terminal-failure code is present, root/parent coverage remains visible, no stale physical slot is drawn, and diagnostics stay bounded. The test must not expect target SSE when transition reserve cannot fit.

- [ ] **Step 5: Retain cache/churn/resize/disposal proof**

Update `geo-virtual-raster-dem.mjs` so persistent-cache reload, rapid camera churn, resize, duplicate dispose and managed process cleanup run against GPU demands. Cache reuse must not change frontier order or sampling output.

- [ ] **Step 6: Run browser gates and inspect screenshots**

```bash
node tests/browser/geo-gpu-tile-frontier-core.mjs
node tests/browser/scratch-dem-layer.mjs
node tests/browser/geo-virtual-raster-dem.mjs
```

Expected: each emits `status: "passed"`; screenshot and proof-mask paths exist; no upper-half coarse/missing terrain region appears at high pitch; all spawned browser/Vite/tile-server processes close.

- [ ] **Step 7: Commit Task 6**

```bash
git add tests/browser/scratch-dem-layer.mjs tests/browser/geo-virtual-raster-dem.mjs examples/demLayer/main.ts
git commit -m "Verify GPU-driven DEM frontier"
```

---

### Task 7: Clean-Cut Legacy Selector and Record the Accepted Architecture

**Files:**
- Delete: `examples/demLayer/terrain-selection.ts`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Modify: `tests/dem-flow-cleanup.test.js`
- Modify: `tests/examples-structure.test.js`
- Create: `docs/decisions/ADR-061-gpu-resident-tile-frontier-dem.md`
- Modify: `docs/vision/scratch-graphics-kernel.md`
- Modify: `docs/vision/geo-api/geoscratch-geo-api-vision-docs/05-tiles-lod-streaming-residency/README_zh.md`

**Interfaces:**
- Consumes: completed GPU implementation and browser evidence。
- Produces: no production/test dependency on the legacy selector; accepted ADR with exact ownership and evidence。

- [ ] **Step 1: Add the legacy-absence RED assertion**

```js
expect(fs.existsSync(path.join(root, 'examples/demLayer/terrain-selection.ts'))).to.equal(false)
expect(allProductionSources).to.not.match(/selectTerrainNodes|uploaded-indirect-arguments/)
```

Run the focused cleanup tests and confirm RED while the file still exists.

- [ ] **Step 2: Delete the selector and obsolete snapshots**

Delete `terrain-selection.ts`; remove imports and tests that preserve old camera-neighborhood counts, CPU node arrays, legacy `slice(0, maxNodes)` behavior or selection-shaped Virtual Raster plans. Keep only a test-only CPU oracle for the new frontier semantics in `gpu-tile-frontier-reference.ts`.

- [ ] **Step 3: Write ADR-061**

ADR must state:

- Scratch owns execution/resources/provenance only;
- Virtual Raster slot table is generic physical-to-virtual metadata;
- Geo owns persistent frontier, visibility, SSE, budget, balance, demand and diagnostics;
- DEM owns level metrics, page-to-patch interpretation, shaders and mesh-stitching;
- CPU event path still owns network/worker/cache/residency acknowledgement;
- matrix and sampling levels are distinct;
- no-hole parent handoff and deterministic compaction are mandatory;
- legacy CPU selector is removed during `0.x.x` with no compatibility path.

- [ ] **Step 4: Update active vision without rewriting history**

Document that Scratch's existing indirect/readback primitives were sufficient and no tile API entered core. Link the design spec, implementation plan, ADR and browser proof; do not edit superseded ADR facts except adding an explicit supersession note when required.

- [ ] **Step 5: Run cleanup scans and commit Task 7**

```bash
rg -n "selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes|uploaded-indirect-arguments" examples/demLayer packages/geoscratch/src tests docs --glob '!docs/superpowers/specs/**' --glob '!docs/superpowers/plans/**'
npm --workspace geoscratch run build
npx mocha tests/scratch-dem-layer-clean-cut.test.js tests/geo-virtual-raster-dem.test.js tests/dem-flow-cleanup.test.js tests/examples-structure.test.js
git diff --check
git add -A examples/demLayer/terrain-selection.ts tests/scratch-dem-layer-clean-cut.test.js tests/geo-virtual-raster-dem.test.js tests/dem-flow-cleanup.test.js tests/examples-structure.test.js docs/decisions/ADR-061-gpu-resident-tile-frontier-dem.md docs/vision/scratch-graphics-kernel.md docs/vision/geo-api/geoscratch-geo-api-vision-docs/05-tiles-lod-streaming-residency/README_zh.md
git commit -m "Remove legacy DEM tile selection"
```

Expected: search results are limited to historical design/plan/audit discussion or explicit negative assertions; focused cleanup tests PASS.

---

### Task 8: Full Regression, Visual Review, and Final Audit

**Files:**
- Create: `docs/review/gpu-resident-tile-frontier-dem-final-audit.md`
- Modify only if a gate exposes an in-scope defect: files already listed in Tasks 1-7

**Interfaces:**
- Consumes: all implementation commits and generated browser JSON/screenshots。
- Produces: one bounded final audit classifying the result as `confirmed-clean` or `completed-with-findings`。

- [ ] **Step 1: Run static and package gates**

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Run required real-browser gates**

```bash
node tests/browser/geo-gpu-tile-frontier-core.mjs
node tests/browser/scratch-dem-layer.mjs
node tests/browser/geo-virtual-raster-dem.mjs
node tests/browser/scratch-hello-gaw.mjs
node tests/browser/scratch-flow-layer.mjs
node tests/browser/geo-virtual-raster-dynamic-flow.mjs
```

Expected: all emit `status: "passed"`, no managed process remains, and no console/WebGPU/unhandled-rejection failures occur.

- [ ] **Step 3: Inspect desktop/mobile/high-pitch captures**

Use Playwright output PNGs plus `view_image`/pixel checks. Record viewport, pitch, bearing, camera, frontier counts, min/max levels and screenshot SHA-256. Reject blank canvas, inverted DEM, cross-page seam, mesh crack, upper-screen coarse slab, text/UI overlap or stale-slot flash.

- [ ] **Step 4: Audit hot-path and ownership facts**

Run:

```bash
git diff --name-only 399a416..HEAD
git diff 399a416..HEAD -- packages/geoscratch/src/scratch
rg -n "selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes|lodArguments\.upload|terrainArguments\.upload" examples/demLayer
```

Expected: no Scratch diff, no legacy production symbol, and changed files remain inside the approved Geo/DEM/test/docs boundary.

- [ ] **Step 5: Write the final audit**

The audit records commit ids, exact commands/results, browser/adapter facts, screenshot paths/hashes, current bounded diagnostic facts, CPU/GPU oracle comparison, clean-cut scan, and any real residual issue. Do not convert a finding into a new implementation scope during this goal.

- [ ] **Step 6: Commit the audit and report terminal classification**

```bash
git add docs/review/gpu-resident-tile-frontier-dem-final-audit.md
git commit -m "Audit GPU-resident DEM frontier"
git status --short --branch
```

Expected repository state: `dev-feature` contains all verified commits; only the user's pre-existing `AGENTS.md` modification may remain unstaged. Report `confirmed-clean` when every gate passes. If implementation is complete but an environmental/external gate fails, report `completed-with-findings` with command, cause, impact and evidence; do not call an unresolved product defect clean.

---

## Fixed Termination Rules

1. The plan ends after Task 8; new Flow LoD, globe, occlusion, editable terrain, per-page residual-error generation or generalized scene scheduling becomes a separately approved design.
2. A failed test is fixed only when it exercises an approved invariant; unrelated failures are reported with evidence and are not absorbed into this implementation.
3. No task is reopened after its commit unless a later fixed gate proves a regression attributable to that task.
4. Completion means implemented code plus current test/build/browser/git evidence, not the existence of a plausible architecture or partial shader.
5. The pre-existing generic `VirtualRasterAccessor` non-zero tile-coverage/fallback transform defect and dense-versus-sparse page-table redesign are recorded in the final audit but are not silently folded into this DEM-frontier goal: the DEM uses its explicit WebMercator address sampler and finite source coverage, while either generic fix changes a separate public sampling/storage contract and requires its own approved clean-cut design.
