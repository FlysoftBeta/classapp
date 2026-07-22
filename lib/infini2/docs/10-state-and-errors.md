# 状态、错误与恢复

## 1. 前台 Phase

前台 phase 只描述用户当前主要体验，不等同于所有后台任务状态。

| 状态          | 含义                       | 是否可有旧主内容  |
| ------------- | -------------------------- | ----------------- |
| dormant       | 尚未启动                   | 否                |
| bootstrapping | 首次/重试建立片段          | re-bootstrap 可有 |
| ready         | 主片段可用                 | 是                |
| seeking       | 正在离散定位或 jump        | 是，继续显示      |
| failed        | 当前前台意图失败并可 retry | 是，若此前已有    |

Ready 额外带 `empty`，只有合法的双端 exhausted 空 bootstrap 才为 true。

## 2. 任务状态与 Phase 正交

Ready 时仍可能有 before/after edge fetch；seeking 时旧 edge fetch 也可能继续；detached 任务成功会
保存 Stale，但不改变前台 phase。UI 应分别观察 phase 和方向 loading，不把“有任何 Promise”误作
全局 loading。

## 3. 前台与后台失败

失败是否改变 phase 取决于任务是否仍影响当前主意图：

- 首次 bootstrap 失败：进入 failed/bootstrap；
- 当前显式或预测 seek 失败：进入 failed/seek；
- 当前主边界 edge fetch 失败：进入 failed/fetch，同时保留已提交内容；
- detached activation 失败：只调用 `onError(foreground=false)`；
- 已不影响主片段的旧 edge 请求失败：只上报背景错误；
- Candidate 覆盖不足或 Provider 顺序冲突：按对应前台任务失败。

Error 对象原样保留，非 Error rejection 会包装为 Error。

## 4. Failure Latch

Edge failure 会锁住具体 owner/direction frontier，阻止每次 settle 自动立即重发形成请求风暴。
`retry()` 或明确 `reopen(direction)` 解除相关路径。视图轻微变化不能暗中清除失败。

Retry 保留原意图：

- bootstrap 使用原初始 cursor/target；
- seek 使用原 target、方向和 alignment；
- fetch 重开原方向，从当前有效边界重新调度。

非 failed 状态调用 retry 是无操作。

## 5. Provider Contract Failure

以下应作为可诊断的 checked failure，而不是 silent repair：

- 单 page stable ID 重复；
- 空 page 未 exhausted 相关边；
- 空 bootstrap 未双端 exhausted；
- 开放 candidate 实测不足 VisibleWindow；
- 公共 ID 顺序冲突；
- edge anchor 对象已丢失；
- 进入 Predict Zone 但 Provider 未实现 locateOffset；
- jump 未提供 targetToCursor。

顺序冲突时可删除 Stale 以保护主片段；不能尝试复杂版本猜测。

## 6. DOM/生命周期错误

- 没有 live document 创建 DOM host：构造失败；
- 已 dispose 后调用 controller/host：抛出明确错误；
- Wasm ABI 版本不符或分配失败：初始化失败；
- 旧 layout revision ACK：返回 false，调用者重新 reconcile；
- 非法/迟到 measurement：忽略或返回 0，不破坏结构；
- dispose 多次：安全无操作。

## 7. Error UI 建议

若已有主内容，保留列表并在相关边显示重试入口；只有首次 bootstrap 没内容时显示全页错误。错误
回调适合遥测，phase 适合用户界面。背景 detached 错误通常只记录，不打断用户。

## 8. 可观测性

建议记录：operation、direction、foreground、错误类型、当前 phase、两侧 exhausted/loading、Buffer
数量、主/Stale 是否存在、layout revision、有效任务数。不得记录完整业务 item 或 opaque cursor，
除非应用自己的隐私策略明确允许。

## 9. 恢复边界

Retry 只能恢复同一 Provider/身份域中的瞬时或 checked 请求失败。以下需要重新创建 controller：

- 更换账号或数据集；
- stable ID 语义变化；
- Provider cursor 协议变化；
- 应用希望彻底放弃现有 registry 和 tombstone。

不要用 revision/generation 强制“刷新所有东西”；显式重建生命周期边界更清晰。
