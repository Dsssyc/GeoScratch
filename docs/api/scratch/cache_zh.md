---
docId: scratch.cache.zh
canonical: false
translationOf: ./cache.md
canonicalDigest: 4b4024da0062e9aa655bdfabe3bebe9ba3eb30235c02ba234a07583164815015
---
# 持久缓存

[English](./cache.md) | [Scratch 概览](./README_zh.md)

`PersistentCache` 是独立于 Worker、GPU 与 Geo 的浏览器持久化原语。IndexedDB 保存
metadata，并作为权威 commit point；可选 raw `ArrayBuffer` 使用 OPFS 中不可变的
`(id, revision)` 路径。只有 metadata commit 后记录才可见，因此中断的 payload 写入
不会伪装成完整条目。

使用 `persistentCacheDescriptor` 可以同步校验并冻结 namespace、budget、lifecycle、
history 与 persistence-request policy，且不会访问 IndexedDB、OPFS 或
`navigator.storage`。Descriptor 失败使用 `cache-descriptor` 诊断阶段。
`PersistentCache.open` 消费同一份规范化 contract，只负责异步获取和初始化存储。

应用选择禁用或持久化，并提供 lifecycle policy。Session cleanup 适合一次性可视化
数据，durable reuse 适合编辑与恢复。Quota 限定字节数和条目数，invalidation 与
garbage collection 都是显式操作。Scratch 不加入隐藏 JS 内存缓存，也不把 cache
record 转成 GPU 资源。

调用方保留 key、revision、metadata schema 与 coherence 的语义所有权。使用
`persistentCacheKey` 规范化身份。每个 `PersistentCache` descriptor 约束一个 namespace
instance；应用把一个 logical cache 分散到多个 Worker 时，adapter 必须划分应用级 byte
与 entry 总预算。DEM adapter 会精确划分，并在 entry 预算少于 Worker 数时禁用多余
cache shard。Cache 诊断报告存储阶段和证据，但不与具体 loader 或数据格式耦合。
