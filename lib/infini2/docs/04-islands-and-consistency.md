# 多岛、合并与一致性

## 1. 为什么需要多个 Island

离散跳转或 re-bootstrap 会产生一个新的当前片段，但旧片段可能仍包含未来滚回时有用的数据。
把旧片段立即丢弃会浪费请求；直接拼在新片段旁又会伪造 unknown 距离。Infini2 最多保留：

- 一个主 Island：驱动当前布局；
- 一个前向 Stale Island：逻辑上可能在主片段之前；
- 一个后向 Stale Island：逻辑上可能在主片段之后。

```text
[unknown] [stale-before] [unknown] [main] [unknown] [stale-after] [end?]
```

方向是相对于主 Island 的内容顺序，不是请求完成时间。

## 2. Unknown 不变量

只要两个 Island 尚未通过稳定 ID 锚点证明相连，它们之间就必须存在 unknown。不得：

- 根据两次响应的长度推断间隙 item 数；
- 根据默认高度分配永久像素距离；
- 因 cursor 数值接近就拼接；
- 因两个片段内容文本相同就当成同一 item；
- 用客户端接收时间判断哪个片段位于前后。

离散跳转的空白只是一条临时跑道，不会消除 unknown。

## 3. 合并锚点

两个 Island 的公共 stable ID 是可验证的会合锚点。收集所有公共 ID 后，它们在两侧序列中的
rank 必须严格同向递增。若任意一侧出现相反顺序或重复，说明 Provider 违反顺序不变量，当前
Stale Island 直接丢弃；不尝试版本推断、编辑距离或内容比对。

例如：

```text
stale: a b c A B C D E F
main :             B G D E H
common ordered anchors: B, D, E
```

公共锚点把两侧切成 prefix、anchor gaps 和 suffix。

## 4. 段选择规则

合并以本次主动加载形成的主片段为较新数据，不需要 Provider revision。每一段遵循：

1. 主片段有内容时选择主片段；
2. 主片段该段为空时，可用 Stale 内容补齐；
3. 公共锚点只保留一份；
4. 与 Stale 方位不一致的外侧内容不跨 unknown 注入。

以上例：

```text
stale: a b c A (B) C (D) (E) F
main : none      (B) G (D) (E) H
```

结果保留前向 stale 前缀 `a b c A`，锚点 B–D 间选择较新的 `G` 而不是 `C`，D–E 间为空，
后缀由 main 的 `H` 决定。若这是前向 Stale，旧片段的 `F` 不应越过 main 后端注入。

## 5. 合并后的边界

合并只能继承被实际证明相连的外端边界。主片段内部方向的边界由新的主动响应决定；Stale
片段远离主片段的外端若被完整接入，可以保留其 exhausted 信息。任何仍隔着 unknown 的边界
都不能传播。

合并后，指向旧 Island 的在途 edge 请求不能简单作废。如果 owner 已被吸收，其结果应重定向到
合并后的片段，再按原 anchor 和方向验证。这个重定向只表达本地拓扑，不是 Provider revision。

Candidate 激活时，旧 Main 先成为对应方向的 Stale，并立即尝试锚点合并。目标 alignment 必须在
这些合并全部完成后，基于最终 Main 序列重新求值。Stale prefix/suffix 会改变目标 item 的累计
extent；如果在合并前产生 scroll correction，视口仍会落在 candidate 的旧局部坐标，目标甚至可能
因此不再位于 Layout window。

## 6. 无锚点 Stale 的删除

每次向某个 Stale 方向完成相关加载后，主动检查公共锚点。连续可配置次数仍完全无公共 ID，
就删除该 Stale Island。计数只与“本来应该靠近这个 Stale 的成功加载”有关，其他方向请求、
失败请求或不相关外部更新不能增加它。

删除是有意的简化措施，原因可能是：

- Stale 中内容已在服务端全部删除，通知未及时到达；
- 用户已通过离散路径越过对应位置；
- Provider 无法提供重叠页；
- 旧结果已经没有缓存价值。

系统不得为了挽救它引入 revision 猜测、内容相似度或多版本调和。

## 7. 新旧数据与最终一致性

某个 Island 可以短期和服务器不同，但必须保持合法顺序。最终一致性依赖两点：

- 每个主动响应至少包含请求开始时的最新状态；
- 请求开始后发生的外部 insert/delete 通知有序、不遗漏并最终到达。

数据层记录请求开始时的本地 mutation 游标，响应到达后把此后的通知按原顺序重放到 candidate
或 edge slice，再合并。这样无需服务器 revision，也不会让请求期间到达的删除被旧 response 复活。

## 8. 删除与 Tombstone

收到外部删除后，已知 Island、candidate 和可重放工作都要应用删除。业务 ID 映射保留 tombstone：
迟到 response 再带同一 ID 时过滤掉，且 ID 永不分配新 handle。只有当没有任何片段、任务、布局、
pin 或候选引用时，业务对象本体才可以释放。

## 9. 外部插入

外部插入用“在哪个稳定 ID 前/后”表达。只有包含 anchor 的已知片段能确定局部位置。相同变更要
应用到所有包含该 anchor 的相关片段和候选，以免未来激活旧 candidate 时倒退。若 anchor 对任何
已知片段都不可定位，系统不能凭通知创建全局拓扑；应用可忽略它或等待后续 fetch 带入。

## 10. 内容更新

不改变顺序的内容更新可以直接替换业务对象。它可能导致渲染高度变化，真实 extent 仍以 DOM
后续测量为准。若“更新”会改变顺序，必须表达为 delete + 使用新 ID insert。

## 11. 可验证性质

任意时刻应满足：

- 主 Island 最多一个；每个方向 Stale 最多一个；
- 每个 Island 内 handle 唯一；
- 公共 handle 在可合并片段中的顺序一致；
- 未合并 Island 不共享物理连续坐标；
- main 优先解决公共锚点之间的冲突；
- tombstone 不会由迟到响应复活；
- 删除 Stale 不改变主 Island 的可见语义位置。
