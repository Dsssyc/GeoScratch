---
docId: scratch.lifetime.zh
canonical: false
translationOf: ./lifetime.md
canonicalDigest: 59f3563c55f123d801501f235bb79dab1122e3a411117295f1ca26be35ddc807
---
# 生命周期

[English](./lifetime.md) | [Scratch 概览](./README_zh.md)

`LifetimeScope` 协调混合所有权资源的异步清理。Action 以显式 ownership mode 和
cleanup phase 注册，并在每个 phase 内按注册逆序确定性执行。Dispose 是幂等的，
其报告会包含全部失败，而不会因一次失败放弃后续清理。

Scope 只拥有标记为 owned 的 action；borrowed dependency 仍由调用方负责。停止后的
scope 拒绝新工作，snapshot 只读暴露状态。这是通用生命周期原语，不会推断资源图、
取消任意应用工作或让无关 runtime 共享权威。

当一个装配系统的 teardown 同时涉及 Worker group、GPU 对象、事件监听和应用资源时，
可使用一个 scope。权威应保持局部：child 可以向 owner 注册清理，但不应暗中释放
borrowed parent。
