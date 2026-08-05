# Scratch Persistent Cache 与 Geo DEM raw raster 集成设计

## 状态

已实施。由 ADR-058 与 ADR-059 接受。

## 日期

2026-08-06

## 目标

本设计连续完成两个已经批准的目标：

1. Goal 2：在 `geoscratch/scratch` 中建立独立、领域无关的 `PersistentCache`；
2. Goal 3：让 Geo 只保留 virtual-raster 的缓存地址与元数据适配，并让 DEM example 用持久化 raw height page 验证该边界。

最终公共拓扑仍只有 `scratch` 与 `geo`。Cache、Worker 和 GPU 是 Scratch 中彼此独立的能力域，不共享 runtime、任务队列、缓存状态或生命周期 authority。应用可以组合它们，但任何一个能力域都不得在内部依赖另外两个。

## 固定非目标

- 不实现应用级 JavaScript memory cache；
- 不实现 Cache 与 GPU Buffer/Texture 间的转换 API；
- 不把 DEM source、decoder、mesh-stitching、terrain shader 或 layer lifecycle 提升进 Geo；
- 不推进 Flow Layer 的 virtual-raster LoD；
- 不保留旧 `VirtualRasterCache`、`createVirtualRasterCache()`、memory tier、IndexedDB encoded-PNG store 或兼容 alias；
- 不创建统管 GPU、Worker 与 Cache 的聚合 runtime；
- 不把 OPFS payload 暴露为文件路径或可变文件句柄。

## 规范基线

实现以以下浏览器规范为事实来源：

- [Indexed Database API 3.0](https://w3c.github.io/IndexedDB/)：readwrite transaction 是元数据状态的原子提交边界；cache transaction 使用 `relaxed` durability hint；
- [File System Living Standard](https://fs.spec.whatwg.org/)：`navigator.storage.getDirectory()` 是 origin-private file system 入口；`createWritable()` close 前不发布修改，并尽力避免 partial write；
- [Storage Standard](https://storage.spec.whatwg.org/)：`estimate()`、`persisted()` 与显式 `persist()` 只报告 origin bucket 事实，不虚构持久化保证。

IndexedDB 与 OPFS 之间不存在跨存储引擎事务。因此实现不得宣称二者原子提交，而要用可恢复协议建立明确提交点。

## Scratch 公共契约

### 生命周期

```ts
const cache = await PersistentCache.open<Metadata>({
    namespace: 'application.dataset.v1',
    maxPayloadBytes: 128 * 1024 * 1024,
    maxEntries: 4096,
    maxHistory: 64,
    requestPersistence: false,
})

await cache.dispose()
```

`open()` 是显式异步获取。实例状态为 `active | disposing | disposed`。`dispose()` 幂等，停止接受新操作，等待本实例已经开始的操作，再关闭 IndexedDB connection；它不清空持久化内容。

不存在 no-op cache 对象。上层的“不缓存”语义由不创建 `PersistentCache` 表达。

### 不可变 identity

```ts
const key = persistentCacheKey({
    id: 'domain-neutral/stable-resource-id',
    revision: 'immutable-content-revision',
})
```

`id` 标识逻辑对象，`revision` 标识不可变内容。相同 `(id, revision)` 的首次成功 `put()` 是提交者；后续 `put()` 返回 `already-present`，不静默覆盖。可编辑资源只有在提交出新的 immutable revision 后才能进入 cache，dirty working state 不属于 cache。

namespace 必须是非空、Unicode 完整且 UTF-8 编码不超过 120 bytes 的字符串。OPFS 目录名使用这些 bytes 的小写十六进制可逆编码，因此不会因 `TextEncoder` 替换孤立 surrogate 而发生命名空间碰撞，生成的路径分量也保持在浏览器文件系统边界内。

### 元数据与 raw payload

```ts
await cache.put(key, {
    metadata: { format: 'r8uint', width: 256, height: 256 },
    payload: rawArrayBuffer,
})
```

- metadata 是 cache 在调用时取得的 structured-clone snapshot，存入 IndexedDB；
- payload 是可选的、非空的 whole `ArrayBuffer`，以不可变文件存入 OPFS；
- 省略 payload 即为合法的 metadata-only entry；
- `put()` 不 detach、接管或修改调用方 buffer；
- cache hit 返回一个由调用方独占的新 `ArrayBuffer`，调用方可以 transfer；
- Cache 不知道 Buffer、Texture、raster 或 Geo。

### 读取结果

`get()` 不用 `undefined` 混淆正常 miss 与存储不一致：

```ts
type CacheReadOutcome<Metadata> =
    | { status: 'hit', record: CacheRecord<Metadata> }
    | {
        status: 'miss'
        reason: 'absent' | 'payload-missing' | 'payload-size-mismatch'
        diagnostic?: CacheDiagnostic
    }
```

缺失或长度错误的 OPFS payload 被视为可修复 cache miss：实现删除悬空 metadata、增加 repair 事实并返回 warning diagnostic。底层 API 不可用、transaction 失败、未知 filesystem 失败和非法 descriptor 则抛出 `ScratchDiagnosticError<CacheDiagnostic>`。

### 写入、预算与删除

```ts
type CachePutStatus =
    | 'stored'
    | 'already-present'
    | 'too-large'
    | 'quota-exceeded'
```

`maxPayloadBytes` 与 `maxEntries` 都是硬预算。提交新 entry 的同一 IndexedDB readwrite transaction 选择并删除 LRU metadata victims，确保 transaction 完成时的 metadata 视图不超过预算。metadata-only entry 仍计入 entry budget。

公共删除能力为 exact `delete(key)`、`invalidate({ idPrefix })` 与 `clear()`。`idPrefix` 是领域无关的稳定 ID 前缀；Geo 可以通过自身 address 编码获得按 source、matrix 或 plane 收敛的前缀。

### 一致性与恢复协议

每个 payload 使用随机 immutable payload ID，不从用户 key 派生文件名。

一次 payload `put()` 按以下顺序执行：

1. 在 IndexedDB `pendingPayloads` 中登记 payload ID；
2. 通过 OPFS writable 写入唯一文件并 close；
3. 在一个 IndexedDB readwrite transaction 中检查 immutable key、执行 LRU、发布 entry metadata、删除 pending row；
4. transaction `complete` 是 cache entry 的唯一提交点；
5. 提交后尽力删除被替换或驱逐的旧 payload 文件。

失败恢复规则：

- 文件写失败时删除本次 pending row 和临时 payload；
- metadata transaction 失败时 entry 不可见，并清理本次 payload；
- open 时删除超过 recovery grace period 的 pending payload；
- garbage collection 只删除既未被 committed entry 引用、也未被 live pending row 引用的文件；
- garbage collection 在删除每个候选文件前用一个 IndexedDB snapshot 重查 committed entry 与 pending row；writer 只有在 commit transaction 中仍持有自己的 pending row 才能发布 metadata；
- open/read 发现 invalid metadata 后，必须在执行删除的同一 IndexedDB readwrite transaction 中重读；若另一 context 已提交合法修复，则保留新记录并重试读取，不能按过期 snapshot 删除；
- read 与 delete 竞态导致旧 payload 消失时，读取者重读一次 metadata；若 revision 已换则读取新 payload，若 metadata 已删除则返回正常 miss；
- 所有未知清理失败进入 bounded history，不把已经成功提交的 entry 伪装成失败。

这套协议不宣称 IndexedDB 与 OPFS 原子。它以 IndexedDB 为 authoritative commit point，并保证崩溃后状态可判定、可回收。

### 诊断与有界事实

`ScratchDiagnosticDomain` 增加 `cache`，统一 union 变为：

```ts
type ScratchDiagnostic = GPUDiagnostic | WorkerDiagnostic | CacheDiagnostic
```

Cache diagnostics 包含 code、phase、subject、operation、key/revision、storage error name 与 retriable 等结构化事实。`ScratchDiagnosticErrorContext` 增加 `{ domain: 'cache', storage?: CacheStorageErrorFacts }`。

`inspect()` 只返回固定计数、容量、storage estimate、persistence 结果和不超过 `maxHistory` 的历史。`observationScope: 'instance'` 明确说明 entry 容量事实与计数是该实例已观测的 namespace 状态，而不是伪造的跨 context 同步快照。raw payload、完整 metadata 和无界 key 列表不得进入诊断历史。

## Geo 适配边界

旧 `virtual-raster-cache.ts` 被删除。Geo 新增纯适配：

```ts
const address = virtualRasterCacheAddress({
    sourceId,
    tileMatrixSetId,
    tileMatrixSetUri,
    matrixId,
    tileRow,
    tileColumn,
    plane,
    coherence,
    sourceRepresentation: 'image/png',
    payloadRepresentation: 'raw/uint8',
    decoderVersion,
    sampleType: 'uint8',
    schemaVersion: 2,
})
```

返回值只包含：

- 一个领域无关的 Scratch `CacheKey`；
- 可 structured-clone 的 `VirtualRasterCacheMetadata`；
- 可用于 application invalidation 的稳定 ID prefixes。

Geo 不打开 IndexedDB/OPFS，不持有 cache lifecycle，不实现 LRU，也不提供 memory tier。
每个 Geo 字段和最终组合出的 Scratch key 都必须通过有界校验；非法 Unicode、组合 ID 溢出或 revision 溢出统一抛出 `GEO_VIRTUAL_RASTER_CACHE_ADDRESS_INVALID`，不得泄漏 `URIError` 或 Scratch cache diagnostic。

## DEM example 集成

DEM 只接受 `cache=none` 与 `cache=persistent`。默认 `none`，浏览器持久化证明显式使用 `persistent`。

Worker pipeline 为：

```text
Scratch PersistentCache raw hit
    -> retain decoded page candidate
    -> transfer raw page to main thread

cache miss
    -> fetch encoded PNG
    -> decode once to raw height bytes
    -> retain one bounded cache snapshot
    -> transfer render copy to main thread
    -> scheduler accepts current result
    -> persist retained raw snapshot
```

之所以在 network miss 上存在一次 raw copy，是因为同一 buffer 不能同时：

1. transfer 给主线程并被 residency 接管；
2. 等待 scheduler 确认结果未 stale 后再写 cache。

这份副本只存在于受 Worker/request budget 限制的 pending candidate 中，并在 accept、discard、cancel 或 dispose 后释放。cache hit 直接 transfer OPFS 读取结果，不再次 image decode，也不建立第二份 cache snapshot。

DEM cache metadata 至少记录 width、height、channels、dataType、contentVersion、sourceRepresentation、decoderVersion 与 schemaVersion。读取时验证 metadata 与 payload byte length，不能把损坏 entry 交给 residency。

## 验收

### Goal 2

- public contract typecheck 覆盖 key、generic metadata、read/write outcome、diagnostic narrowing 与生命周期；
- browser proof 覆盖 raw payload、metadata-only、reload hit、immutable revision、LRU byte/entry budget、prefix invalidation、clear、OPFS residue回收、persistence/storage facts 和 terminal dispose；
- Node 环境缺失 IndexedDB/OPFS 时返回 cache-domain Scratch diagnostic；
- package root 仍只有 `scratch` 与 `geo` namespace，package exports 不增加第三个子路径。

### Goal 3

- Geo 只导出 address/metadata/coherence adapter，不再导出 cache runtime/store/policy；
- DEM public query 与 facts 只出现 `none | persistent`；
- persistent camera return 增加 raw cache hit，network request 与 image decode 不增加；
- 新 Worker/page lifecycle 使用同一 namespace 时能从 persistent raw payload 恢复，且 image decode 为零；
- none mode 不保留结果；
- existing DEM rendering、mesh-stitching、WebMercatorQuad、GPU residency、Worker cancellation 与 lifecycle browser gates 继续通过；
- full typecheck、`npm test`、`npm run build`、cache browser proof、DEM browser proof、Hello GAW 与 Flow Layer regression gates 通过。

## 收敛规则

1. 设计、Scratch Cache、Geo adapter、DEM integration、docs/audit 各自形成可回滚 commit；
2. 完成后执行一次完整门禁；
3. 只修复 Goal 2/3 diff 造成的确定性失败；
4. 之后只做一次 bounded diff review；
5. 不追加 Flow LoD、Service Worker、application memory cache、GPU cache adapter 或其他新能力；
6. 最终报告 `confirmed-clean`，或在 goal 标记完成后报告 `completed-with-findings` 及准确原因；
7. 本轮不 push。
