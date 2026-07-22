# 总体模型与架构

## 1. 问题定义

Infini2 面向双向、动态高度、潜在无限且无法一次获知全貌的有序内容。典型场景是聊天、
时间线、日志、小说章节和审计记录。它同时处理五个互相耦合的问题：

- 只渲染可见区域附近的少量元素；
- 在未知内容上提供足够大的可滚动表面；
- 对 prepend、删除、异步测量和容器变化做滚动补偿；
- 在连续加载与离散跳转之间切换；
- 在请求乱序完成、外部通知异步到达时维持顺序和最终一致性。

这里最重要的限制是：客户端通常既不知道总 item 数，也不知道未知 item 的实际高度。
因此不能把所有内容投影成一个可信的全局像素轴。系统只能对已知的连续片段给出精确几何，
对未知区域给出有限的预测性空白。

## 2. 设计目标

### 2.1 正确性

- 可见水位线上的语义位置在几何变化前后保持稳定。
- 已确定的 item 顺序不会被本地推测重排。
- 请求完成顺序不会决定内容正确性。
- 不把未证明相连的内容片段拼接起来。
- 半完成的 bootstrap 不能形成小于可见窗口的开放内容。
- DOM 提交必须确认它对应的准确布局版本。

### 2.2 性能

- 长序列的插入、删除、按位置查找和 extent 更新不做线性整体重写。
- 布局查询的成本与命中的 item 数有关，而不是与全部已知 item 数有关。
- 测量、DOM 移动和 scroll 修正尽量合并到一个显示帧。
- 快速滚动先使用 overscan；超过精确连续范围后才转为离散定位。

### 2.3 平台独立

顺序、窗口、驻留、岛、任务和补偿的决策属于平台无关核心。DOM 只负责读取物理几何、
挂载节点和写入滚动位置；React 只负责组件生命周期和内容渲染。未来的 Vue、原生或其他
平台适配层不应复制核心决策。

## 3. 分层

```text
应用 / UI
   |
React 适配层（可选）
   |
DOM 执行层（Web 平台）
   |
数据与异步工作层（业务对象、cursor、Provider）
   |
平台无关核心（顺序、extent、窗口、驻留、岛、锚点、任务）
```

依赖只向下流动，结果和命令向上返回：

| 层               | 拥有的数据                            | 可以做什么                             | 不可以做什么                       |
| ---------------- | ------------------------------------- | -------------------------------------- | ---------------------------------- |
| 平台无关核心     | 数值 handle、extent、拓扑、状态       | 决定窗口、加载意图、合并、补偿         | 持有业务对象、发网络请求、访问 DOM |
| 数据与异步工作层 | 业务 item、stable ID、cursor、Promise | 调 Provider、映射 ID、重放外部变更     | 推测 DOM 高度、直接写 scrollTop    |
| DOM 执行层       | 节点、ResizeObserver、物理坐标        | 隐藏测量、节点移动、布局 ACK、滚动写入 | 决定数据新旧或岛合并               |
| React 适配层     | portal 内容、组件生命周期             | 提供声明式渲染和状态订阅               | 接管稳定节点的位置和身份           |

## 4. 两套正交的窗口

系统同时使用 extent-based 与 length-based 两套视图。

- extent-based 视图回答“像素轴上的哪一段需要可见或布局”；
- length-based 视图回答“哪些已知 item 需要留在客户端以及何时再请求”。

两者不能合并成一个固定 overscan 数：动态高度意味着相同像素范围会包含不同 item 数，
而 Provider 请求往往又不能精确返回某个 item 数。Layout 先用像素选中基础 item，Resident
再按 item 数向两端延伸，Buffer 接住一次请求多出的内容。

## 5. 已知片段与未知间隙

一个 Island 是顺序已知且连续的 item 片段。主 Island 是当前驱动 UI 的片段；旧的、可能
仍可复用的片段位于其前方或后方。任意两个尚未合并的片段之间都必须视为 unknown：

```text
[unknown] [old fragment] [unknown] [current fragment] [unknown] [old fragment] [end?]
```

unknown 没有可靠 item 数或 pixel extent。系统不为它分配永久的“真实距离”，只在当前主
片段开放的两端提供有限空白跑道。进入远端空白会触发新的定位和 bootstrap。

## 6. 身份与顺序模型

Provider 为每个业务 item 提供稳定 ID。数据层把它映射成非零数值 handle，平台无关核心只
处理 handle。必须满足：

1. 同一逻辑 item 始终使用同一 ID；
2. 已删除 ID 永不复用；
3. 两个已有 item 的相对顺序一旦确认就不改变；
4. 业务“移动”表达为删除旧 ID，再插入新 ID；
5. 单个 Provider page 内 ID 唯一并按内容顺序排列。

这些条件让公共 ID 可以成为跨 Island 合并锚点，而不需要 Provider revision。

## 7. 核心数据结构要求

每个连续片段需要支持：

- 按 rank 插入和删除；
- 由 handle 查 rank 和 prefix extent；
- 更新单项 extent；
- 求子树 item 数和总 extent；
- 查询与像素范围相交的 item；
- 输出稳定的 content order。

实现使用带聚合信息的平衡隐式序列树，使单项编辑和定位为对数复杂度，范围输出为
`O(log n + k)`。绝对 start 是查询结果，不存成需要随 prepend 整体改写的字段。

## 8. 决策与副作用分离

核心永不直接执行异步请求。它产生带身份的工作票据，外层解析票据、调用 Provider，最后把
结果带回。这样可以在不依赖网络取消的前提下判断一个迟到结果应：

- 应用到当前片段；
- 作为旧片段保存；
- 等测量后激活；
- 因违反顺序而拒绝；
- 因不再有引用价值而丢弃。

同理，核心只产生 scroll correction；物理层实际写入滚动位置，再把新视图回传确认。

## 9. 生命周期概览

```text
dormant
  -> bootstrap request
  -> candidate hidden mount and measure
  -> candidate commit
  -> ready
       -> adjacent edge fetch -> ready
       -> predictive or explicit seek -> candidate -> ready
       -> checked failure -> failed -> retry -> previous operation
  -> dispose
```

Re-bootstrap 和 seek 期间，已经提交的主内容可以继续显示。只有第一次 bootstrap 没有可保留
内容时才通常显示空壳或应用自己的 loading UI。

## 10. 安全边界

核心会防御 NaN、负 extent、无效数值枚举、旧布局 ACK 和不存在的任务；数据层会防御重复 ID、
非法空 page 和开放 bootstrap 覆盖不足。但它不能验证服务器是否漏发永远不会到达的通知，
也不能从完全不重合的片段推断真实顺序。后两者属于 Provider 契约。
