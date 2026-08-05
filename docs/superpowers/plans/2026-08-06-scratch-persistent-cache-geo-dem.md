# Goal 2/3 Scratch Persistent Cache 与 Geo DEM 执行计划

## 固定目标

在 `dev-feature` 上 clean-cut 完成独立 Scratch Persistent Cache，并以 Geo virtual-raster adapter 和 DEM raw-height persistent reuse 做完整验证。计划边界由 `docs/superpowers/specs/2026-08-06-scratch-persistent-cache-geo-dem-design.md` 固定。

## Phase 1：契约 RED

- [ ] 新增 Scratch Cache public type fixture；
- [ ] 新增 cache-domain diagnostic 与 unavailable runtime unit test；
- [ ] 更新 Scratch/Geo exact public symbol tests，先证明旧 Geo cache API 与新 Scratch API 的差异；
- [ ] 新增 browser fixture 的 raw/meta/reload/budget/invalidation/cleanup 断言；
- [ ] 运行目标测试并保存预期 RED 证据。

## Phase 2：Scratch Cache

- [ ] 建立 `scratch/cache/` 的 types、diagnostics、browser storage 与 lifecycle authority；
- [ ] IndexedDB 保存 metadata、entry index 与 pending journal；
- [ ] OPFS 保存 immutable raw payload；
- [ ] 实现 immutable put、read retry/repair、LRU、invalidate、clear、GC、storage facts 与 dispose；
- [ ] 将 CacheDiagnostic 接入 ScratchDiagnostic union/context；
- [ ] 导出到 `geoscratch/scratch`，不新增 package subpath；
- [ ] 通过 Cache typecheck、unit、browser proof；
- [ ] 提交 Scratch Cache checkpoint。

## Phase 3：Geo clean cut

- [ ] 用纯 `virtualRasterCacheAddress()` 适配替换 `virtual-raster-cache.ts`；
- [ ] 保留 immutable/revisioned/editable coherence，但只映射 Scratch key 与 metadata；
- [ ] 删除 Geo cache runtime、store、policy、memory tier 与 IndexedDB backend exports；
- [ ] 更新 Geo exact export manifest 与 adapter tests；
- [ ] 通过 Geo contract/unit/typecheck；
- [ ] 提交 Geo adapter checkpoint。

## Phase 4：DEM raw payload

- [ ] DEM policy 收敛为 `none | persistent`；
- [ ] Worker cache hit 直接构造 raw page candidate，不调用 image decode；
- [ ] network miss decode 一次，并只为 deferred accept 保留受限 raw snapshot；
- [ ] accept 后写 persistent raw payload，discard/cancel/dispose 不提交；
- [ ] 更新 worker facts 与 request phase/budget accounting；
- [ ] 更新 DEM browser proof，覆盖 camera return 与新 lifecycle 的零重复 decode；
- [ ] 通过 DEM targeted browser gate；
- [ ] 提交 DEM checkpoint。

## Phase 5：文档与审计

- [ ] 新增 ADR-058 接受 Scratch Persistent Cache；
- [ ] 新增 ADR-059 接受 Geo adapter 与 DEM raw cache；
- [ ] 标记 ADR-056 的 encoded/memory cache 决策被取代；
- [ ] 更新 Scratch/Geo vision、README、living review 与 public manifests；
- [ ] 扫描活跃源码/测试/用户文档，确认旧 API 只存在于历史 allowlist；
- [ ] 提交 docs/audit checkpoint。

## 固定门禁

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node tests/browser/geo-virtual-raster-cache.mjs`
- [ ] `node tests/browser/geo-virtual-raster-dem.mjs`
- [ ] `node tests/browser/scratch-hello-gaw.mjs`
- [ ] `node tests/browser/scratch-flow-layer.mjs`
- [ ] Git diff bounded review：只审 Goal 2/3 改动一次
- [ ] `git status --short --branch` 干净且只在 `dev-feature`
- [ ] 不 push

## 终止条件

所有固定门禁通过后标记 goal 完成并报告 `confirmed-clean`。若实现已完成但存在环境性或外部门禁问题，也标记 goal 完成并报告 `completed-with-findings`，逐项说明命令、原因、影响、已保留证据与建议动作。本计划禁止把新发现扩展成 Flow LoD、memory cache、Service Worker 或 GPU adapter 工作。
