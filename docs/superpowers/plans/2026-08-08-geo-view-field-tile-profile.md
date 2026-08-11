# Geo View、Field 与 Tile Spatial Profile 实施计划

> 状态：已完成并验证。

**目标：** 在不改变 DEM 当前渲染结果的前提下，把 GPU frontier 从 WebMercator
硬绑定抽离为多根 topology + spatial profile，并让 DEM 使用公开 GeoView、view
demand、GeoField、TiledFieldRepresentation 与 MapFieldLayer 边界。

**架构：** 现有 Scratch command graph、Virtual Raster residency 和 DEM pipeline
保持不变。Geo 新增不可变宏观对象；frontier descriptor 由裸 address codec clean-cut
迁移到 profile；profile 同时提供 CPU oracle 与 WGSL 空间 lowering；DEM adapter 负责
将 MapLibre camera 转成 GeoViewSnapshot。

**约束：** 不实现 globe renderer、simulation/editor demand、cache/worker ownership
迁移或 DEM source 行为变化；不回退当前 worktree 中已有的 DEM 精简改动。

---

## Task 1：冻结 topology/profile 契约

**Files:**

- Create: `tests/geo-tile-spatial-profile.test.js`
- Create: `packages/geoscratch/src/geo/tile-topology.ts`
- Create: `packages/geoscratch/src/geo/tile-spatial-profile.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`

1. 写 RED tests，覆盖 regular `1 x 1` 与 `2 x 1` root forest、root-aware canonical
   key、parent/children、越界诊断和不重叠 planar bounds。
2. 运行 focused test，确认因公开符号不存在而失败。
3. 实现 immutable `TileTopology` 与 regular root-grid factory。
4. 实现 `TileSpatialProfile` 契约、WebMercator planar profile 及用于确定性测试的
   regular planar profile。
5. 运行 focused test，确认通过。

## Task 2：将 GpuTileFrontier clean-cut 迁移到 profile

**Files:**

- Modify: `tests/geo-gpu-tile-frontier.test.js`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier-wgsl.ts`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier.ts`

1. 先修改测试，要求 descriptor 使用 `spatialProfile`，并增加 `2 x 1` root forest
   的 CPU oracle split/compaction proof。
2. 运行 focused test，确认旧 `addressCodec` API 失败。
3. 让 layout validation 通过 profile 校验 TileMatrixSet/coverage/root address。
4. 将 CPU `tileBounds`、canonical path 和 root identity 改为 profile 调用。
5. 将 WebMercator boundary/bounds WGSL 移入 profile 生成模块；frontier WGSL 只消费
   稳定函数接口。
6. 保持 buffer layout、command count、submission ordering、feedback ABI 与 DEM policy
   不变。
7. 运行 frontier focused tests。

## Task 3：增加 GeoViewSnapshot 与 MapLibre adapter 边界

**Files:**

- Create: `tests/geo-view.test.js`
- Create: `packages/geoscratch/src/geo/geo-view.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/dem-map.ts`
- Modify: `examples/demLayer/dem-layer.ts`

1. 写 RED tests，覆盖 typed-array defensive copy、finite facts、epoch/viewport/FOV
   诊断与不可变标量事实。
2. 实现 `createGeoViewSnapshot()`、`GeoViewAdapter` 和公共类型。
3. 把 DEM 的平台 duck typing 留在 example adapter 内，但让 `readDemCameraState()`
   返回公开 snapshot 加 DEM presentation facts。
4. 让 frontier `writeView()` 消费 `GeoViewSnapshot`。
5. 运行 view、frontier 与 DEM camera stability tests。

## Task 4：增加结构化 view demand

**Files:**

- Create: `tests/geo-view-demand.test.js`
- Create: `packages/geoscratch/src/geo/view-tile-demand.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/dem-virtual-raster.ts`
- Modify: `examples/demLayer/dem-layer.ts`

1. 写 RED tests，覆盖 coverage/refinement/prefetch intent、view provenance、stable
   ordering、dedupe、bounded output 和 Virtual Raster demand 显式 lowering。
2. 实现 stateless/bounded `ViewDemandProducer`，不拥有 scheduler 或 request state。
3. 将现有 DEM GPU feedback reconciliation 改为先产生 view demand，再显式降低到
   Virtual Raster demand。
4. 保持 sticky parent transaction、generation cancellation 和 failure semantics 不变。
5. 运行 view-demand、frontier 与 virtual-raster focused tests。

## Task 5：增加 GeoField、TiledFieldRepresentation 与 MapFieldLayer

**Files:**

- Create: `tests/geo-field-layer.test.js`
- Create: `packages/geoscratch/src/geo/geo-field.ts`
- Create: `packages/geoscratch/src/geo/map-field-layer.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `examples/demLayer/dem-virtual-raster.ts`

1. 写 RED tests，覆盖 field semantic validation、representation compatibility、Map
   profile guard，以及 layer 不拥有 cache/worker/runtime/scheduler 的结构断言。
2. 实现 immutable descriptors/factories；不增加 renderer base class 或 lifecycle
   state machine。
3. DEM 构造 height field、WebMercator tiled representation 和 map field layer，并从
   该组合取得 profile/demand producer。
4. 运行 field/layer 与 DEM structure tests。

## Task 6：文档、全量验证与浏览器回归

**Files:**

- Create: `docs/decisions/ADR-067-geo-view-field-tile-spatial-profile.md`
- Modify: `docs/vision/geo-api/geoscratch-geo-api-vision-docs/05-tiles-lod-streaming-residency/README_zh.md`
- Modify: `docs/vision/geo-api/geoscratch-geo-api-vision-combined_zh.md`
- Modify: `docs/review/gpu-resident-tile-frontier-dem-final-audit.md`

1. 记录接受的 topology/profile/view/field/layer 边界、未来 globe profile 门禁和被拒绝
   的统一 projection flag/隐藏 layer ownership。
2. 运行 `npm test`。
3. 运行 `npm run typecheck`。
4. 运行 `npm run build`。
5. 启动 DEM 前后端，使用 dedicated browser 跑 WebGPU smoke；验证加载、相机俯仰/
   旋转/缩放、wireframe、indirect frontier feedback、无 console error 和非空 canvas。
6. 审查 `git diff`，确认没有回退或误收已有 DEM 精简改动。
7. 最终报告明确区分：本轮确认无问题的门禁、发现但不属于本轮的 globe 专用缺口，
   以及任何无法完成的 browser/hardware 验证。

## 完成事实

- Task 1-5 已按 clean-cut 契约完成，旧 `addressCodec` frontier descriptor 未保留；
- Task 6 已完成 ADR、vision、最终审计、全量测试、类型检查、生产构建和 dedicated
  Chrome WebGPU 回归；
- 全量测试为 `1398 passing, 2 pending`，两个 pending 均为仓库声明的环境/能力门禁；
- headless Chrome `151.0.7922.77` 在 Apple `metal-3` adapter 上完成 12 个相机场景、
  84 步快速相机变化、resize、失败注入和完整 cleanup，结果为 `status: passed`；
- 本轮没有实现或暗示 globe spatial evaluator、simulation/editor demand producer，
  也没有把 cache、Worker、scheduler 或 GPU runtime 收入 layer 所有权。
