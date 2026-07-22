# Rust crate API 指南

Rust crate 提供平台无关的数值核心，适合 WebAssembly 外的原生适配、核心单元测试和新的执行层。
它不持有业务 item、cursor、Provider、DOM 或 async runtime。

## 1. 基本模型

应用先把 stable ID 映射为非零 `u32` handle，并为每项提供估计 extent：

```rust
use infini2_core::{Engine, ViewMetrics};

let mut engine = Engine::new(48.0);
engine.set_resident_padding(20, 20);
engine.set_view(ViewMetrics {
    scroll: 0.0,
    viewport: 800.0,
    inset_start: 64.0,
    inset_end: 0.0,
    layout_before: 800.0,
    layout_after: 800.0,
});
let bootstrap = engine.begin_bootstrap(0);
assert_ne!(bootstrap, 0);
```

随后执行层从 outbox 读取任务，调用自己的 Provider，把 `Item` 切片提交回核心；candidate 先用
`candidate_rows` 获取目标布局，测量后 `commit_candidate`。

## 2. Handle 所有权

0 是所有数值 ID 的 invalid sentinel。调用者分配的 handle 必须：

- 非零；
- stable ID 生命周期内不变；
- 删除后不复用；
- 不在同一 Island 内重复。

核心通过 released 队列告知某 handle 已不被任何内部片段引用。只有取到 released 后，外层 registry
才可释放业务对象映射；即使如此也应保留 ID tombstone 防止业务层复用。

## 3. View 与窗口

`ViewMetrics` 使用主 Island surface-local 像素语义。所有输入会归一化。可通过 `window`、
`visible_window`、`layout_target`、`blank_extent`、`surface_extent` 和 `island_origin` 读取几何。
`LayoutCommitted` 只在物理层成功 ACK 后有意义。

## 4. 任务协议

- `begin_bootstrap`/`begin_explicit_seek` 创建 activation 任务；
- `pop_effect` 读取待执行任务；
- `effect` 查询仍存活任务；
- `commit_effect_items` 提交响应并返回 disposition；
- Candidate disposition 需要测量和显式 `commit_candidate`；
- `reject_effect` 锁住相关失败 frontier；
- `detach_effect` 只让 activation 脱离前台，不全局删除；
- `effect_affects_main` 用于判断失败是否仍影响当前主内容。

Effect 的 target token 完全由外层解释。核心只原样保存，便于把任务和业务 jump intent 关联。

## 5. 数据变更

`external_insert` 与 `external_delete` 同时应用到相关片段并写本地 journal。`measure_batch` 更新 extent。
这些操作会自动捕获/恢复默认顶部 anchor；需要其他水位线时先显式 `capture_anchor`。

`trim_buffer` 是显式内存淘汰，不进入外部 mutation journal。`reopen_edge` 用于业务边界从 exhausted
恢复 open。

## 6. 布局事务

`query_layout` 返回借用的临时 row slice；下一次需要复用内部 scratch buffer 的查询会使旧借用
失效（Rust 借用检查也会约束这一点）。物理层提交节点后调用 `commit_layout(revision, handles)`。
Revision 不匹配或 handle 不属于主片段会返回 false。

`measure_batch`、数据变更、视图变化都可能推进 revision。不要缓存 `ItemSnapshot.start` 跨 revision。

## 7. 滚动补偿

`capture_anchor(ratio)` 保存语义点。改变几何后，`take_scroll_correction` 返回绝对 local scroll
目标并消费它。执行层写物理滚动，再调用 `set_view` ACK。没有 correction 时返回 None。

## 8. Island 观察

`main_id`、`stale_id`、`island_role`、`island_edge` 和 `island_rows` 主要用于执行层和诊断。调用者
不得自行拼接 Island 或修改公开快照来绕过合并规则。`Island` 的公开统计只读；序列本身不暴露。

## 9. Diagnostics

Diagnostics 统计序列节点访问、实际修改和范围输出量，用于复杂度测试与性能观测，不是业务计费
或稳定 ABI。计数饱和而不溢出。

## 10. Panic 与非法输入

公共数值输入尽可能归一化或以 false/invalid sentinel 拒绝。内部结构损坏只应在 debug validation
或不可恢复 invariant 处 panic。Release Wasm 配置使用 abort；外层仍必须在进入核心前检查 Provider
契约，不能把不可信业务输入直接当作 handle/enum。

## 11. 文档生成

```sh
npm run docs:infini2
```

该命令检查本目录相对链接，并用 warnings-as-errors 生成 crate rustdoc。Crate 根文档和每个公开
类型、字段、枚举 variant、函数都必须通过 missing-docs 检查。
