# GPU-Resident Tile Frontier DEM Final Audit

## Terminal Classification

`confirmed-clean` on 2026-08-06 at implementation commit `d2787d9`.

The Underwater Terrain example now derives its active terrain frontier, visible instances, virtual
raster demands, and indirect draw arguments from the persistent GPU tile frontier.
All specified static, native-browser, visual, lifecycle, ownership, and clean-cut
gates passed. No in-scope product defect remains open.

## Audited Commit Chain

The audited range is `399a416..d2787d9`. Its principal checkpoints are:

- `e154437`: plan the GPU-resident terrain frontier;
- `9a996f1` through `3c5bf48`: define and implement the canonical frontier ABI,
  reference oracle, and compute execution core;
- `c794aa0` through `43768d5`: add generic current-content readback and atomic
  submission authority required by bounded GPU feedback;
- `3ad797f` through `0e9a782`: implement, consume, prove, and document the bounded
  GPU feedback ring;
- `657a4c3` through `4336836`: add generation-safe residency, demand
  reconciliation, render templates, map metadata, and migrate DEM rendering;
- `ac2ca9e`, `d4d881d`, and `d2787d9`: preserve demand masks, harden convergence,
  and prevent parent/child LoD fixed-point oscillation;
- `6c51b00`: remove the legacy CPU selector and record the clean cut.

`git log --oneline 399a416..d2787d9` is the exact complete commit inventory.

## Static And Package Gates

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed package build, repository TypeScript, examples TypeScript, and WebGPU type checks. |
| `npm test -- --reporter dot` | `1361 passing`, `2 pending`; both pending cases are declared environment/capability gates. |
| `npm run build` | Passed package and Vite production builds. Vite emitted only its existing chunk-size advisory. |
| `git diff --check` | Passed with no whitespace error. |

The declaration parity gate reports 86 JavaScript/declaration pairs and 5,352
declaration signatures. The full suite includes the CPU reference oracle, packed ABI,
GPU feedback, virtual-raster ownership, generation, cancellation, cache, DEM clean-cut,
and public-surface assertions.

## Native Browser Gates

All required scripts emitted `status: "passed"` on headed Chrome
`150.0.7871.188` using the Apple `metal-3` WebGPU adapter:

- `node tests/browser/geo-gpu-tile-frontier-core.mjs`;
- `node tests/browser/scratch-underwater-terrain.mjs`;
- `node tests/browser/underwater-terrain-streaming.mjs`;
- `node tests/browser/scratch-hello-gaw.mjs`;
- `node tests/browser/scratch-flow-layer.mjs`;
- `node tests/browser/geo-virtual-raster-dynamic-flow.mjs`.

Every managed Chrome, Vite, tile-server, and owned port closed after its proof. The
DEM proof reported zero diagnostic incidents, uncaptured WebGPU errors, device losses,
console failures, page errors, request failures, pending native observations, and
effectful submitted work after drain. Double disposal remained equivalent and
idempotent.

## CPU/GPU Frontier Evidence

The CPU reference and native WGSL implementation retain the same deterministic
ordering, budget, hysteresis, visibility, SSE, residency-generation, and balancing
semantics. The native off-axis proof retained four far children because their visible
parent would immediately exceed the refine threshold; it reported one refine
candidate, zero coarsen candidates, nine active frontier entries, and no stale
generation, demand, fallback, or overflow.

The final gate exposed and fixed one real convergence defect. Under a narrow, pitched
viewport, four children could satisfy their own coarsen threshold while the larger
parent AABB immediately satisfied the refine threshold. The frontier alternated
between those states without resource work. CPU and WGSL coarsen selection now reject
that group when the proposed visible parent would immediately refine. A focused RED
oracle test reproduced the cycle before the fix, the native off-axis proof exercises
the same rule, and the real mobile DEM scenario now converges with a stable generation
and byte-identical repeated frames.

## Visual Evidence

All camera rows use center `[120.980697, 31.684162]`; each retained three stable
frames with one frontier signature and identical first/final pixel hashes.

| Scenario | Viewport | Camera | Frontier / visible | Levels | Final PNG SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Desktop high pitch | 1024x768 | zoom 9, pitch 85, bearing 90 | 24 / 23 | 9..10 | `b7c6d94c11a25831e6bb7bd4a8299c7486e11e05978513e20ff95f009dd1821b` |
| Desktop high pitch | 1024x768 | zoom 10, pitch 85, bearing 225 | 23 / 17 | 9..10 | `1e416ed73db629e1a67f3066d62a7c254cda1ff07c095007e5dc82d40351881b` |
| Mobile pitched | 390x844 | zoom 10, pitch 70, bearing 90 | 19 / 10 | 9..10 | `a3643571ca3ff534895f07cd4376a78315c2d8b6376afbb0faf3c885482c7ef4` |

The corresponding files are under `/tmp/geoscratch-underwater-terrain-browser/` as
`pitch85-bearing90-z9-stable-final.png`,
`pitch85-bearing225-z10-stable-final.png`, and
`mobile-pitch70-bearing90-z10-stable-final.png`.

Manual original-resolution inspection and pixel checks rejected blank output,
orientation inversion, transparent holes, cross-page seams, mesh cracks, stale-slot
flashes, and the former upper-screen coarse rectangle. Every high-pitch capture spans
the full tested horizontal extent; the mobile terrain bounds are 390x812 inside the
390x844 canvas.

## Virtual Raster Failure And Pressure Evidence

| Proof | Bounded result | PNG SHA-256 |
| --- | --- | --- |
| Page boundary | Converged with zero transparent pixels; returned and repeated camera hashes are identical. | `3f4d55b10ae2a1b17f1863eb8ba79e1da4ae64d85788978295225f7463ddf234` |
| Terminal child 404 | One failed child remains terminal, its parent stays visible, demand reaches zero, and the frontier converges. | `5548f0820cda52940238f1c3eb017b237f41e9972218cdaf669b01f609334dba` |
| Two-page pressure | One level-4 parent remains stable with `budget-limited` state and an identical repeated hash. | `dbd5cb626adc093da066a14b85f325c3c51578be4be8c5dca937133c355a4aa4` |

The operational proof observed finite maxima of two network requests and one decode,
then zero active/queued work and zero staging bytes. Its camera-churn case recorded 26
cancellations and 25 stale results before converging on the newest generation. A fresh
lifecycle restored 41 raw pages from persistent cache with zero network requests and
zero image decodes. These are bounded CPU orchestration facts; GPU frontier selection
does not acquire network, cache, or Worker ownership.

## Ownership And Clean-Cut Audit

`git diff --name-status 399a416..d2787d9` keeps implementation changes inside the
approved Scratch prerequisite, Geo, Underwater Terrain example, tests, ADR/vision, plan, and review
boundaries. Scratch changes are exactly six files implementing the generic ordered
readback/submission-authority prerequisite (942 insertions and 38 deletions). A scan of
added Scratch lines finds no Geo, DEM, `VirtualRaster`, or tile-frontier policy or
import.

`examples/underwaterTerrain/terrain-selection.ts` is deleted. The following production-symbol
scan returns no match:

```bash
rg -n "selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes|lodArguments\.upload|terrainArguments\.upload" examples/underwaterTerrain
```

The example contains no parallel CPU selector, CPU-visible-instance upload, CPU draw-
count upload, compatibility alias, or fallback feature flag. GPU feedback is bounded
and delayed; CPU reads only compact diagnostics/demands and performs request/residency
reconciliation. The user's pre-existing `AGENTS.md` modification was not staged or
altered by this goal.

## Fixed Boundary

There is no residual issue in the accepted DEM frontier. Generic non-zero coverage
origin/fallback transforms for every future `VirtualRasterAccessor`, and a possible
dense-versus-sparse page-table redesign for much larger address spaces, remain
separate Geo architecture work. Globe traversal, occlusion, editable terrain,
per-page residual-error generation, Flow LoD, and generalized scene scheduling are
also outside this terminated goal and were not silently absorbed into it.

## 2026-08-08 Geo Composition Extension

本节记录在上述 DEM frontier 验收之后完成的通用 Geo 抽象，不改写前述历史 commit
区间和当时的测试数字。

### 结论

本轮范围内没有遗留失败项。DEM 已真实迁移到公开的 `TileTopology`、
`TileSpatialProfile`、`GeoViewSnapshot`、`ViewDemandProducer`、`GeoField`、
`TiledFieldRepresentation` 和 `MapFieldLayer`，不是仅在测试中构造的占位接口。

- `GpuTileFrontierDescriptor` clean-cut 改为接收 `spatialProfile`；CPU oracle、WGSL、
  feedback canonicalization 和 camera fixed encoding 不再直接依赖 WebMercator；
- regular quadtree topology 已用真实 `2 x 1` root forest 证明两个根的 bounds、路径、
  split 和 compact 互不混淆；
- DEM 的 MapLibre 事实只停留在 example adapter 内，每帧产生防御性复制、不可变且带
  frame/residency epoch 的 view snapshot；
- 延迟 GPU feedback 与产生它的原始 snapshot 一起保留，epoch 不一致会在修改
  generation/request 状态前失败；
- GPU feedback 先成为带 provenance 的 coverage/refinement/prefetch view demand，再由
  显式 adapter 降为 Virtual Raster scheduler demand；
- field 语义、tiled physical representation 和 map presentation 已分离；layer 不拥有
  cache、Worker、network、scheduler、residency、atlas、runtime 或 submission。

### 当前验证

| 门禁 | 结果 |
| --- | --- |
| Geo/frontier/DEM focused tests | `123 passing` |
| 公共导出和结构审计 focused tests | `7 passing, 1 pending` |
| `npm test -- --reporter dot` | `1398 passing, 2 pending` |
| `npm run typecheck` | 通过 package、repository、examples 和 WebGPU 类型检查 |
| `npm run build` | 通过 package 与 Vite production build；仅保留既有 chunk-size advisory |
| `git diff --check` | 通过 |

Dedicated headless Chrome `151.0.7922.77` 使用 Apple `metal-3` WebGPU adapter 完成
12 个相机场景、84 步快速相机变化、resize 以及两个失败注入场景，最终
`status: passed`。正常路径的 console、page、request 和 HTTP failure 均为 0；387 个
frame work 全部完成，dispose 后 native observation 和 effectful submitted work 均为 0。
800x600 resize 截图非空，terrain 横向覆盖率为 1，像素 SHA-256 为
`aecf2d4f3b345ac37adb552f9bf2346380b4bca72c1f9161bbc22a7205cc91c7`。Chrome、Vite
和 tile server 均已关闭。

### 明确剩余边界

`2 x 1` 证明的是多根 topology 与 planar profile 已从单根 WebMercator 假设中解耦，
不等于 globe 已实现。真正的 globe 仍需单独设计并验证 curved tile bounds、ellipsoid
relative precision、horizon/frustum culling、globe SSE 与对应 WGSL lowering。simulation
和 editor 需求也仍应作为可组合 producer 进入同一 demand 边界，不能被 screen view
冒充。上述项目均不属于本轮完成声明。
