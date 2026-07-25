# Infini2 设计与 API 文档

这组文档是 Infini2 的规范性说明。它描述外部可观察行为、数据协议、状态转换、
正确性条件和接入方法；设计章节刻意不依赖私有类型、字段或函数名称。实现可以重构，
但这里写明的不变量不能在没有同步修改协议、测试与文档的情况下改变。

## 阅读路线

首次接入建议按下列顺序阅读：

1. [总体模型与架构](./01-architecture.md)：系统边界、职责分层、核心术语和设计目标。
2. [窗口、坐标与空白区](./02-windows-and-coordinates.md)：所有 extent-based window 的精确定义。
3. [驻留、Buffer 与内容边界](./03-residency-and-buffer.md)：数据加载和内存策略。
4. [多岛、合并与一致性](./04-islands-and-consistency.md)：离散内容片段如何安全重连。
5. [工作循环与异步任务](./05-work-loop.md)：事件、请求、测量、提交和过期结果的时序。
6. [测量、提交与滚动补偿](./06-measurement-and-anchor.md)：DOM 几何正确性的完整协议。
7. [Provider 与外部变更协议](./07-provider-contract.md)：后端必须满足的契约。
8. [TypeScript/React API 指南](./08-typescript-api.md)：面向应用开发者的公开 API。
9. [Rust crate API 指南](./09-rust-api.md)：平台无关核心的嵌入方法。
10. [状态、错误与恢复](./10-state-and-errors.md)：状态机、失败隔离和重试规则。
11. [测试、构建与验收](./11-testing-and-operations.md)：正确性矩阵和发布检查。
12. [不变量清单](./12-invariants.md)：评审和回归时的快速核对表。

如果只是使用 React 组件，可先读第 1、2、7、8、10 章。如果要实现新的平台适配层，
必须完整阅读第 1–7、9、10 章。

## 规范用语

本文档中的“必须”“不得”是正确性要求；“应”“建议”是默认策略，偏离时需要有等价的
正确性证明和覆盖测试；“可以”表示允许但不要求。

设计文档中的 Main、Visible、Layout、Resident、Buffer、Blank Zone、Island、Anchor 等是
逻辑概念，不承诺对应某个同名对象。API 章节会使用真实公开符号名，因为这些名称就是调用契约。

## 文档与源码的关系

- TypeScript 公开 API 的字段级语义以源码 JSDoc 为准，API 指南解释组合用法和时序。
- Rust 公开 API 的字段级语义以 rustdoc 为准，Rust 指南解释嵌入边界。
- 本目录是设计不变量和跨层协议的主要来源。

## 非目标

Infini2 不提供业务缓存、数据库、网络协议、服务端 revision、全局 index、内容排序算法、
动画滚动策略或 UI 样式。它只管理已知片段的拓扑、几何、驻留、异步工作票据和滚动稳定性。
