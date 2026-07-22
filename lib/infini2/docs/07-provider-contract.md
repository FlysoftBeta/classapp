# Provider 与外部变更协议

## 1. Provider 的职责

Provider 把业务数据源适配为三个能力：从某 cursor 建立连续片段、从已知边界向一侧扩展、以及
可选的离散偏移定位。Infini2 不规定 cursor 类型；它可以是 ID、时间、opaque token 或复合对象。

Provider 不需要返回总数、全局 index、revision 或 generation，也不需要让 cursor 可比较。

## 2. Stable ID 契约

每个 item 必须可提取 stable ID，并满足：

- 在内容生命周期内唯一；
- 删除后永不复用；
- 一旦两个 ID 的相对顺序被确认就不改变；
- 同一 page 中不得重复；
- 同一 ID 在不同响应中表示同一逻辑 item。

违反这些规则会破坏合并锚点。需要移动 item 时必须使用新 ID。

## 3. Page 契约

每次 bootstrap/fetch 返回一个按 content order 排列的连续切片和两端 exhausted 标志。

“连续”表示：在响应所代表的服务器视图中，page 第一项和最后一项之间不存在被静默省略的 item。
它不要求 page 必须与客户端当前片段重叠；不重叠会暂存为独立片段或增加无锚点计数。

边界标志的含义：

- `exhaustedBefore=true`：page 第一项之前没有内容；
- `exhaustedAfter=true`：page 最后一项之后没有内容；
- false 表示可能还有内容，不承诺数量。

## 4. 空 Page

- 向 before fetch 返回空 items 时，必须 `exhaustedBefore=true`；
- 向 after fetch 返回空 items 时，必须 `exhaustedAfter=true`；
- bootstrap 返回空 items 时，两端都必须 exhausted；
- 空且相关边仍 open 是 checked Provider failure，不能无限重试形成 busy loop。

## 5. targetSize

`targetSize` 是期望覆盖的像素量，不是 item 数。Provider 应利用服务端已知信息或合理估计，一次
返回足够连续 item。它可以返回更多，多出的会进入 Buffer；也可因真正 content end 返回更少。

开放 bootstrap 若实测总 extent 小于 VisibleWindow 会被拒绝。Provider 因数据高度未知时，应
宁可适度多取，而不是严格按平均 item 数截断。

## 6. bootstrap

输入：

- `cursor`：初始位置或 jump 转换后位置，可为 null；
- `targetSize`：应覆盖的像素量；
- `signal`：资源取消提示。

返回 page 应围绕或邻近 cursor，具体 inclusive 语义由应用自行统一。若还要把一个业务 target
精确对齐到某项，应用提供额外 target resolver 从 page 中选择 stable ID。

## 7. fetch

输入：

- 已知边界 item 的 cursor；
- `before` 或 `after`；
- 目标像素量；
- AbortSignal。

Provider 可以采用 inclusive 返回边界 item，也可以 exclusive，但必须始终一致并返回连续顺序。
Infini2 会用 stable ID 去重和检查重叠。推荐 inclusive，因为公共 anchor 有利于 Island 合并。

## 8. locateOffset

仅 Blank Predict Zone 需要：

- `anchor` 是当前已知业务 item；
- `signedItemOffset` 是由未知像素距离估算的相对 item 数；
- 返回可用于 bootstrap 的 cursor；
- 可选返回最接近预测落点的 stable ID。

这个接口允许误差，bootstrap 会重新建立精确局部几何。普通连续滚动不得调用它。若产品不需要
离散滚动，可不实现；用户进入 Predict Zone 时将得到可诊断失败。

## 9. 新鲜度而非 Revision

每个响应至少要反映请求发起时的数据状态。请求之后发生的改变可以不在 response 中，因为外部
通知会补齐。Provider 不得要求 Infini2比较 revision，也不应返回 generation。

外部通知流必须：

- 对同一内容序列有序；
- 不遗漏；
- 允许异步延迟；
- 最终一定到达。

主动请求和通知之间不要求全局顺序，客户端 mutation journal 负责重放。

## 10. 外部插入、删除和更新

### 插入

用 anchor ID、before/after 和一段 content-order items 表达。插入 items 自身也必须 stable ID 唯一。
通知应在服务端确定顺序后发送。

### 删除

发送 stable ID 列表。删除可以先于包含该 ID 的请求结果到达；tombstone 会阻止迟到复活。

### 更新

只改变 item 内容，不改变 ID 或相对顺序。可能影响高度时，DOM observer 会重新测量。

### 边界重开

如果此前 exhausted 的流因新内容变为开放，外界显式重开相应方向。单纯 update 不会改变边界。

## 11. AbortSignal

Signal 用来取消昂贵 I/O 和释放连接，但正确性不能依赖 Provider 一定响应 abort。Promise 仍可能
成功或失败；Infini2 会根据任务身份安全保存、应用或丢弃。Provider 不应在 abort 后复用同一个
Promise 给另一个逻辑请求。

## 12. 错误分类

Provider 可抛任意错误，数据层归一化为 Error。以下属于 checked contract failure：重复 ID、
非法空 page、开放 bootstrap 覆盖不足、与已知顺序冲突、缺少被实际使用的 locateOffset、丢失
anchor 对象。它们进入框架失败/错误回调，不应导致未捕获 DOM 崩溃。

## 13. Provider 实现清单

- 明确 cursor 的 inclusive/exclusive 语义并保持一致；
- page 永远按内容顺序，不按请求方向倒序；
- 使用 stable、永不复用的 ID；
- targetSize 尽量按像素覆盖而非固定小页；
- 空结果设置正确 exhausted；
- 事件通知有序、不漏、最终到达；
- 不添加 revision/generation 依赖；
- 把 AbortSignal 传到网络层但不以取消保证正确性；
- 为 20V 离散滚动需要实现 locateOffset；
- 在测试中故意乱序完成请求和延迟通知。
