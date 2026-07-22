# 驻留、Buffer 与内容边界

## 1. 为什么驻留不能只用像素窗口

Layout window 解决当前挂载与测量，但 Provider 常按页返回，单页可能远大于 Layout；同时在
动态高度列表中，一个像素窗口包含的 item 数变化很大。如果把下载和布局绑定在一起，会出现：

- 一次响应多出的 item 被立刻丢弃；
- 下次向同方向加载又请求同一段；
- 固定 item cap 在极高或极矮 item 下表现不稳定；
- 内存淘汰和“是否需要请求”被错误耦合。

因此驻留使用 Layout 的命中结果作为基础，再按 item 数延伸。

## 2. Resident 的精确定义

每次视图、extent 或内容拓扑变化后重新计算：

```text
base = 与 Layout window 实际相交的已知 items
Resident.start = base.first - residentBefore
Resident.end   = base.last + 1 + residentAfter
```

边界截断在主 Island 内。Resident 的容量是动态的：它随 viewport、overscan、真实 item 高度和
当前位置变化。`residentBefore`、`residentAfter` 只是基础布局范围外的 item 数 padding，
不是 Resident 总 cap。

若 Layout 没有直接命中但主 Island 非空，使用 Layout 中点附近 item 作为基础，保证 Resident
仍是连续非空范围。

## 3. Buffer 是水位线标签

主 Island 始终可按当前 Resident 边界解释为：

```text
[BufferBefore] [Resident] [BufferAfter]
```

Buffer 不是独立容器，也没有自己的固定大小。它表示“已知且已请求，但当前位于 Resident 外”的
内容。其唯一加载语义是：

- 若目标方向 Buffer 非空，系统不得向该方向再次请求；
- 用户滚动后 Resident 重算，边界向 Buffer 移动并自然消耗它；
- 只有相关 Buffer 耗尽、边仍 open、且布局需要更多内容时才可请求。

这正好接住 Provider 无法精确返回 Resident 所需数量的情况，而不需要把一个 request 包装成
eviction-atomic，也不需要记录 request generation。

## 4. 请求触发条件

某方向的普通 edge fetch 同时要求：

1. 已有主 Island；
2. 对应边为 open；
3. 该方向 Buffer 为 0；
4. 没有同一有效 frontier 的在途请求或失败锁；
5. 当前不在等待 scroll correction ACK；
6. 当前不是应走 Predict Zone 的离散位置。

响应到达后先与当前拓扑对齐，再扩展主 Island 或保存为旧片段。Resident 随后重新计算，多出的
items 自动成为 Buffer。

## 5. Buffer 与内存淘汰必须分离

Buffer 本身不意味着应保留无限内容。应用可显式调用淘汰操作，为某方向设置最多保留多少个
Buffer item。淘汰规则：

- 只能从主 Island 的对应外端开始删除；
- 不能删除 Resident 内 item；
- 遇到被 pin 的 item 必须停止，不能越过它制造洞；
- 删除后该边回到 open，因为被丢弃内容未来可能需要重取；
- 必须做锚点补偿并释放不再被任何 Island、candidate 或任务引用的 handle；
- 淘汰不是服务端删除，不写入外部 mutation journal。

因此“Buffer 有内容，不请求”与“内存策略决定是否 trim”是两个独立决策。

## 6. Content window

Content window 是全部内容的逻辑全貌，通常不可见也无法物化。Infini2 只通过两端边界状态表达：

- open：该方向可能还有内容；
- exhausted：Provider 明确证明该方向没有内容。

社媒流可以永远 open；有限文档最终两端 exhausted。边界状态属于具体连续片段，不允许跨 unknown
间隙推导：一个旧片段的 exhausted-after 不能自动证明当前主片段的 after exhausted。

## 7. 外部订阅范围

应用可以读取当前 Resident 的首尾 stable ID，作为服务端事件订阅提示。该范围：

- 是 inclusive 范围；
- 可能为空；
- 随滚动和测量变化；
- 只是优化，不能成为正确性依赖；
- 取消旧范围与订阅新范围之间的事件仍必须由外部通道保证最终不遗漏。

不用订阅机制的应用可以把全部有序通知交给 Infini2；与已知片段无关的变更不会凭空建立顺序。

## 8. Pin 与 Resident

Pin 用于临时保持一个具有用户交互状态的 item，例如包含焦点的行。Pin 不改变 Resident 边界，
但布局查询会额外包含被 pin 的 item，淘汰不能跨过它。失焦或交互结束后应及时 unpin，否则会
长期扩大 DOM 和内存占用。

## 9. 典型过程

假设 Layout 命中 item 100–119，配置两端各延伸 20 个：

```text
Resident = 80–139
主 Island 已知 50–180
BufferBefore = 50–79（30 个）
BufferAfter  = 140–180（41 个）
```

向后滚动到 Layout 命中 130–150 后：

```text
Resident = 110–170
BufferBefore = 50–109
BufferAfter  = 171–180（仍非空，所以不 fetch after）
```

继续滚动直到 Resident 触及 180，BufferAfter 变为 0；若 after open 且布局需要扩展，才发起下一次请求。
