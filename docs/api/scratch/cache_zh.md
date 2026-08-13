---
docId: scratch.cache.zh
canonical: false
translationOf: ./cache.md
canonicalDigest: c747ad854a3a8879300366890dc4394dea89c5300175654493fd8c110b782afd
---
# 持久缓存

[English](./cache.md) | [Scratch 概览](./README_zh.md)

`PersistentCache` 是独立于 Worker、GPU 与 Geo 的浏览器持久化原语。IndexedDB 保存
metadata，并作为权威 commit point；可选 raw `ArrayBuffer` 使用 OPFS 中不可变的
`(id, revision)` 路径。只有 metadata commit 后记录才可见，因此中断的 payload 写入
不会伪装成完整条目。

应用选择禁用或持久化，并提供 lifecycle policy。Session cleanup 适合一次性可视化
数据，durable reuse 适合编辑与恢复。Quota 限定字节数和条目数，invalidation 与
garbage collection 都是显式操作。Scratch 不加入隐藏 JS 内存缓存，也不把 cache
record 转成 GPU 资源。

调用方保留 key、revision、metadata schema 与 coherence 的语义所有权。使用
`persistentCacheKey` 规范化身份。Cache 诊断报告存储阶段和证据，但不与具体 loader
或数据格式耦合。
