# DEM Cache 配置面板设计

## 状态

已批准，待实现。

## 日期

2026-08-07

## 目标

为 `examples/demLayer/` 增加一个紧凑、可折叠的缓存配置面板，让用户无需手写查询参数即可选择已有缓存策略、调整完整缓存预算，并通过一次明确的“应用并刷新”动作生效。

面板只负责 DEM example 的应用配置。它不得向 Scratch `PersistentCache`、Geo virtual-raster 或 Worker 公共接口加入 UI 语义，也不得建立第二套缓存生命周期模型。

## 固定非目标

- 不在运行中的 Worker、`PersistentCache` 或 GPU virtual-raster 上热切换缓存策略；
- 不把配置面板提升为 `geoscratch` 公共 API；
- 不持久化 cache payload、metadata、key 列表或运行时诊断到 `localStorage`；
- 不增加 JavaScript memory cache；
- 不用 `Restore defaults` 隐式删除已有 durable cache 数据；
- 不改变 `cache=none | persistent` 与现有 `cacheLifecycle` 查询参数契约；
- 不把 atlas、相机、terrain shader 或其他 DEM 参数混入本面板。

## 面板技术

使用 Tweakpane 4，并作为 `examples` workspace 的构建依赖安装。它提供 TypeScript/ES module 接口、folder、binding、button、disabled state 和可定制主题，适合当前“主策略 + Advanced + 显式应用”的工具面板。

面板挂载到 DEM 页面自身的固定 `aside` 容器中，不使用 CDN。Vite 必须把依赖纳入 example 构建，从而保持离线构建可重复，并避免新增运行时第三方网络依赖。

## 配置模型

面板维护一份与 UI 无关的语义配置：

```ts
type DemCachePanelPolicy =
    | 'disabled'
    | 'session'
    | 'durable'
    | 'clear-on-open'

type DemCachePanelConfig = Readonly<{
    policy: DemCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: 'best-effort' | 'request'
}>

type StoredDemCachePanelConfig = Readonly<{
    schemaVersion: 1
    config: DemCachePanelConfig
}>
```

映射到现有查询参数时：

| 面板策略 | 查询参数 |
| --- | --- |
| `disabled` | `cache=none` |
| `session` | `cache=persistent&cacheLifecycle=session` |
| `durable` | `cache=persistent&cacheLifecycle=durable-reuse` |
| `clear-on-open` | `cache=persistent&cacheLifecycle=durable-clear-before-open` |

其余字段分别映射到 `cacheNamespace`、`cacheMaxMiB`、`cacheMaxEntries` 和 `cachePersistence`。所有范围、namespace 和组合合法性继续由现有 `readDemCachePolicy()` 契约决定；面板状态模块可以提供更早的字段级检查，但不能放宽或复制出不同规则。

默认配置与当前 DEM query contract 一致：

```ts
{
    policy: 'disabled',
    namespace: 'geoscratch-dem-webmercator-raw-v2',
    maxMiB: 128,
    maxEntries: 2048,
    persistence: 'best-effort',
}
```

## 启动优先级

缓存参数集合为：

```text
cache
cacheLifecycle
cacheNamespace
cacheMaxMiB
cacheMaxEntries
cachePersistence
```

页面启动按以下顺序解析：

1. URL 包含上述任一参数时，URL 是本次运行的唯一缓存配置来源；缺少 `cache`、重复参数、被忽略参数或非法值仍由现有严格校验拒绝，不能用本地配置修补非法 URL；
2. URL 完全不含缓存参数时，尝试读取并校验版本化 `localStorage` 配置；
3. 本地配置不存在、版本未知、结构损坏或字段非法时，使用默认 `disabled` 配置；
4. 解析出的面板配置编码为一份规范化 `URLSearchParams`，再交给 `readDemCachePolicy()`，因此运行时只有一个缓存事实来源。

显式 URL 不会在页面加载时静默覆盖已保存偏好。只有用户点击 `Apply & Reload` 才更新 `localStorage`。

## 本地持久化

使用固定 key：

```text
geoscratch.examples.dem.cache-panel.v1
```

只保存 `StoredDemCachePanelConfig`。读取时必须执行完整结构和边界校验，不能把 `JSON.parse()` 结果直接交给 UI 或运行时。

错误处理：

- storage key 不存在：正常使用 URL/default；
- JSON 损坏、schema version 未知或内容非法：忽略该值并尽力删除；
- `localStorage` 因隐私模式、配额或权限失败：页面仍可通过 URL 配置运行，面板显示 `Local preference unavailable`；
- 写入失败时仍允许把完整配置编码进 URL，但面板在刷新后继续显示本地持久化不可用事实，不能宣称偏好已经保存。

namespace 不是凭据，但面板仍不得读取或展示任何 cache entry metadata、payload 或 key。

## 交互与视觉设计

页面右上角显示标题为 `DEM Cache` 的可折叠 Tweakpane：

1. 主区域提供 `Cache policy` 下拉选项：`Disabled`、`Session`、`Durable`、`Clear on open`；
2. `Advanced` folder 默认折叠，包含 `Namespace`、`Maximum MiB`、`Maximum entries` 和 `Persistence`；
3. `Disabled` 时 Advanced 控件保持可见但 disabled，避免用户误以为这些配置仍会生效；
4. 任一字段变化后显示 `Unsaved changes`；当前草稿无效时禁用 `Apply & Reload` 并显示简短字段错误；
5. `Apply & Reload` 先规范化并验证草稿，再保存本地配置、替换 URL 中的缓存参数并调用 `location.replace()`；
6. URL 中的 `tileServer`、`atlasPages`、`proof` 等非缓存参数原样保留；
7. `Restore defaults` 删除本地配置、移除 URL 中全部缓存参数并刷新，使现有默认 `cache=none` 生效；它不直接删除 IndexedDB/OPFS 内容；
8. 面板销毁纳入 DEM page lifecycle，移除自身 DOM 和事件监听器。

主题采用克制的深色工具界面，与 MapLibre dark basemap 协调但保持独立的中性灰、蓝绿色 focus/accent 和清晰边框。禁止渐变、装饰性背景和大圆角。宽度约 304 px，并限制为 `calc(100vw - 24px)`；窄屏默认折叠，桌面默认展开。面板必须位于 MapLibre controls 和 WebGPU canvas 之上，且自身 pointer events 不穿透到地图。

## 模块边界

新增两个 example-owned TypeScript 模块：

```text
examples/demLayer/dem-cache-panel-state.ts
examples/demLayer/dem-cache-panel.ts
```

`dem-cache-panel-state.ts`：

- 定义版本化配置类型与默认值；
- 校验和规范化未知本地值；
- 在 URL、storage 与 default 之间解析有效配置；
- 将配置编码为现有 query contract；
- 替换 URL 中缓存参数并保留无关参数；
- 不依赖 DOM、Tweakpane、Worker 或 Cache。

`dem-cache-panel.ts`：

- 创建和销毁 Tweakpane；
- 维护当前配置与可编辑草稿；
- 动态启停 Advanced 和 Apply 控件；
- 调用注入的 storage/location boundary 完成保存与刷新；
- 不创建或操作 `PersistentCache`。

`main.ts` 在调用 `readDemCachePolicy()` 前解析有效 cache parameters，并在页面生命周期中挂载/销毁面板。`dem-cache-policy.ts` 继续是运行时缓存策略的最终严格解析器。

## 验证

### Node 单元测试

- 无 URL、无 storage 时解析为 `disabled`；
- 完整有效 storage 在裸 URL 下恢复；
- 任一缓存 URL 参数都令 URL 成为唯一来源；
- 非法 URL 不被 storage 修补；
- 损坏 JSON、未知 schema、非法字段安全回退；
- 四种面板策略准确映射现有 query contract；
- query 替换只修改缓存参数并保留其他参数；
- defaults reset 删除缓存参数；
- `readDemCachePolicy()` 接受面板生成的全部规范化配置。

### 浏览器验证

- 面板在桌面与窄屏都不遮挡主要地图交互且文本不溢出；
- Advanced 在 `Disabled` 下禁用，在 persistent 策略下启用；
- 修改多个值不会提前重建 Worker/cache；
- 点击 `Apply & Reload` 后 URL、`localStorage` 与 canvas runtime facts 一致；
- 去掉 URL 缓存参数后重新打开页面会恢复已保存配置；
- 显式 URL 覆盖本地偏好；
- `Restore defaults` 回到 `cache=none`，同时不宣称删除 durable payload；
- localStorage 不可用时 URL 配置仍可运行并显示降级状态；
- 无 console error、page error、WebGPU diagnostic 或既有 DEM 渲染回归。

### 仓库门禁

- `npm run typecheck`；
- `npm test`；
- `npm run build`；
- 新的聚焦浏览器面板 proof；
- 现有 PersistentCache browser proof；
- 现有 DEM virtual-raster browser proof，若既有 headless cancellation timing gate 仍失败，必须分开报告缓存面板事实与原有时序失败，不能降低断言。

## 收敛规则

1. 设计文档形成独立提交；
2. 配置状态模型先以 RED 测试固定，再实现；
3. Tweakpane 接入与浏览器 proof 形成单独可回滚提交；
4. 不改动用户已有的 `AGENTS.md` 工作树修改；
5. 本轮不 push；
6. 最终报告 `confirmed-clean`，或准确列出仍存在的问题与未通过门禁。
