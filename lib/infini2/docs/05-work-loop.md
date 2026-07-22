# 工作循环与异步任务

## 1. 总体流程

```text
DOM scroll / resize / external event
  -> 读取物理视图
  -> 核心重算窗口、Resident 和需要的工作
  -> 数据层管理异步请求
  -> candidate 隐藏挂载并测量（若需要）
  -> 核心提交内容和布局
  -> 同一显示帧移动节点、写高度、应用 scroll correction
  -> 回传修正后的视图作为 ACK
```

循环是事件驱动的，不假设 scroll 事件连续或来自 smooth scroll。直接把 scrollTop 从一个值改到
另一个值必须与逐像素滚动一样正确。

## 2. 工作票据而非全局 Generation

每个异步工作具有独立身份，并记录：

- 工作种类：首次 bootstrap、相邻 edge fetch 或离散 seek；
- 发起时 owner Island；
- 内容方向；
- 稳定 anchor（若适用）；
- 离散估计偏移或外部 target token；
- 目标像素覆盖量；
- 本地外部变更日志起点；
- 当前状态：待处理、已脱离前台、等待 candidate commit 等。

不会创建“最新 generation 并拒绝所有旧 generation”。不同请求可能各自仍有局部价值；是否接收
由任务身份、owner 拓扑和结果顺序决定。

## 3. 相邻 Edge Fetch

普通连续加载流程：

1. 核心确认相关 Buffer 已耗尽且边 open；
2. 产生带边界 anchor 与方向的任务；
3. 数据层用 anchor 的 cursor 调 Provider；
4. 校验 page、过滤 tombstone、重放请求期间通知；
5. owner 未变化时扩展它；owner 已合并时重定向到合并结果；
6. 检查对应 Stale 是否可合并；
7. 重新计算 Resident、Layout 和补偿；
8. 响应多出的内容成为 Buffer。

同一有效 frontier 同时只应有一个请求，避免重复页。Transport 的 AbortSignal 可用于节省资源，
但即使网络层忽略取消，迟到结果也必须安全处理。

## 4. Predictive Seek

当水位线进入 Blank Predict Zone：

1. 用空白距离和默认 item estimate 算 signed item offset；
2. 产生 seek 任务；
3. 数据层调用 `locateOffset(anchor, signedItemOffset)`；
4. 用返回 cursor 调 bootstrap；
5. page 形成 candidate，隐藏测量目标 Layout；
6. 满足覆盖约束后一次性激活；
7. 旧主片段按相对方向成为 Stale；
8. 尝试把可由公共锚点证明相连的 Stale 合并进新 Main；
9. 基于合并后的最终序列对 target ID 按期望对齐，并应用 scroll correction。

第二个滚动事件可能让第一条 seek 不再代表前台意图。此时第一任务变为 detached，而不是被全局
作废。

## 5. 命令式 Jump

显式 jump 和 predictive seek 共享 candidate/commit 路径，区别是 target 来自调用者，cursor
通过应用提供的转换获得。显式 target 可以在 page 中解析为 stable ID，并按 start、center、end
或 nearest 对齐。Jump 是命令式意图，返回工作 ID 只用于诊断；调用者不应据此自行提交结果。

## 6. Detached 结果

新的 activation 意图会使旧 bootstrap/seek 脱离前台：

- 旧请求成功且主内容已存在：按旧意图相对方向保存为 Stale；
- 旧请求成功但已无引用价值：丢弃；
- 旧请求失败：通过错误回调报告，但不得把当前主 UI 置为 failed；
- 旧 candidate 已测量但尚未提交：也遵循同样的 Stale 规则；
- 普通 edge fetch 不因另一个 activation 自动脱离，它仍可能安全扩展旧片段。

这让快速来回滚动可以复用已花费的 I/O，同时不让旧结果夺回前台。

## 7. Mutation Journal

每次外部 insert/delete 按到达顺序写入本地日志。任务保存发起时游标。结果提交前：

1. 先根据 Provider page 建立连续片段；
2. 顺序重放游标之后的所有相关 mutation；
3. 应用 tombstone 过滤；
4. 再做 Island 合并或 candidate 提交。

日志游标只是本地重放位置，不能暴露为 Provider revision。只有所有可能引用旧游标的任务都完成，
相应日志前缀才可回收。

## 8. 测量与提交事务

Bootstrap/seek 响应不能直接成为主内容。任务先进入 awaiting commit，物理层：

- 创建真实行节点；
- 在同宽隐藏区域挂载；
- 读取首次高度；
- 把测量提交给核心；
- 核心验证覆盖并计算对齐；
- 物理层移动同一批节点进入 live track；
- ACK 布局 revision；
- 应用 scroll correction。

`.appendChild` 移动的是同一个 node tree，不是 clone 或重新 render，避免状态丢失和闪烁。

## 9. Scroll Correction 屏障

核心产生待应用 correction 后，暂时不根据旧 scrollTop 调度新 seek/fetch。DOM 写入目标滚动位置，
随后新的视图输入清除屏障。若把 correction 与下一次 scroll 事件乱序处理，可能造成虚假离散跳转。

## 10. Re-entrancy 与批处理

Provider Promise、ResizeObserver、scroll 事件和 React 更新都可能在不同 task/microtask 到达。
DOM 层以 animation frame 合并工作，但一个 frame 最多提交一轮 Layout：缺少的行批量进入隐藏
staging，ResizeObserver 汇总尺寸，下一帧再批量测量和提交。测量后扩大的 Layout 范围继续进入下一
帧，而不是在同一帧重复“写 DOM -> 强制布局读取 -> 重算”。Layout overscan 为这一个 frame 的
流水线延迟提供覆盖。

## 11. Dispose

Dispose 后：

- 不再通知订阅者；
- 给所有在途请求发送 AbortSignal；
- 忽略之后的 Promise 完成；
- 断开 observer 和事件监听；
- 销毁平台核心实例；
- 释放 DOM 行节点和 portal 记录。

Dispose 必须幂等。React StrictMode 的 effect replay 需要延迟到微任务检查是否真的永久卸载，避免
开发模式的 setup/cleanup/setup 误销毁唯一 controller。
