# 测量、提交与滚动补偿

## 1. 为什么需要语义锚点

动态列表中，位于视口上方的任何 extent 变化都会改变相同 scrollTop 对应的内容：prepend、
删除、图片加载、字体变化、ResizeObserver、viewport resize、inset 变化、Blank Zone 收缩以及
旧缓存淘汰都可能让画面跳动。单纯记“增加了多少高度”不够，因为多项变化可能交错发生。

Infini2 在变化前捕获一个 item 内的语义点：

```text
anchor = stable item + item 内偏移 + VisibleWindow 内偏移
```

变化后重新查该 item 的 start，计算使它回到相同屏幕位置所需的 scroll。

## 2. 水位线

调用者用 0–1 ratio 选择 VisibleWindow 内的水位线：

- 0：可见顶部，适合常规列表与聊天；
- 0.5：中点，适合阅读定位；
- 1：底部，适合贴底视图。

捕获时找到覆盖水位线的 item，并保存水位线落在 item 内的偏移。Ratio 会截断到 `[0, 1]`。
读取阅读进度不应改变补偿锚点，因此“查看当前 item”与“捕获补偿 anchor”是不同操作。

## 3. 单帧共享锚点

同一帧可能依次发生：外部 prepend、首次测量、ResizeObserver 测量、容器 resize。如果每一步都用
尚未写回的旧 scrollTop 重新捕获，会让后一项覆盖前一项 correction。规则是：

- 已有待应用 correction 时继续沿用同一个 anchor；
- 所有几何 mutation 基于该 anchor 累积；
- DOM 应用 correction 后回传新 view；
- ACK 完成后才允许下一轮重新捕获。

Visible/Layout 的计算在屏障期间使用 correction 目标，而不是旧物理 scroll。

## 4. 锚点删除

若删除包含 anchor 的 item，不能继续引用 tombstone。选择顺序为：

1. 删除位置上的后继 item；
2. 若无后继，选择前驱/内容边界；
3. 主片段为空则清除 anchor；
4. 保持新 anchor 尽量位于原水位线。

这个 fallback 是局部拓扑规则，不要求 Provider 参与。

## 5. 测量协议

估计值只用于初始布局和预测。Candidate 的首次屏障可在独立读阶段使用
`getBoundingClientRect().height`；已挂载行和普通 Layout 扩窗优先使用 ResizeObserver 的
`borderBoxSize.blockSize`，避免写 DOM 后同步强制重排。合法 measurement 必须：

- 关联当前稳定 handle；
- 是有限正数；
- 在节点具有与 live surface 相同可用宽度和相关样式下测得；
- 批量提交，减少重复 settle；
- 在可能影响水位线上方 extent 前捕获 anchor。

无变化的 measurement 不产生新 revision。已经卸载或释放 handle 的迟到 observer entry 应忽略。

## 6. Hidden Measure / Commit

Candidate 的 DOM 流程：

1. 在 live surface 内建立 absolute、hidden、不可交互、宽度 100% 的 staging 区；
2. 用最终行结构创建节点并挂载；
3. 等待一次渲染提交，在独立读阶段批量读取首次高度；
4. 把 measurement 提交给核心；
5. 核心给出最终 layout target 和对齐；
6. 用 `appendChild`/`insertBefore` 把完全相同的节点移入 live track；
7. 只设置 live track 的 surface-relative transform；
8. ACK revision 和真实 handle 集合；
9. 写 scroll correction。

`display:none` 不能用于 staging，因为无法测量。`visibility:hidden` 保留布局但不闪烁。Staging
必须与最终容器同宽，否则文字换行会导致首次提交后立即大幅 reflow。

## 7. Live Layout

Live surface 的高度等于整个 Scrollable window。一个 absolute live track 移动到第一个已提交
Layout item 的 surface start，track 内的行按 content order 使用普通文档流。窗口两端只增删发生
变化的节点，不因头尾增加一行而重挂全部节点。正常连续区间只有一次 track transform；focus pin
等造成不连续区间时，在相邻行之间插入不承载业务内容的 gap。

Layout target 外的未 pin 行会卸载。新行先保留在同宽隐藏 staging；ResizeObserver 给出有限正数
后，下一帧才进入 live track 和 committed handle 集合。测量扩大 Layout 时继续准备下一批，不在
同一帧同步 settle。行 shell 不设置独立定位 transform，因此窗口平移只产生 O(1) 几何样式写入。

对仍在 staging 的 Layout item 发起命令式滚动时，DOM 层接受该命令但不能立即按估计 extent 宣告
成功。命令保留到 item 完成首次测量并进入 live track；先应用同帧的 anchor correction，再以真实
extent 执行 start/center/end 对齐。该顺序保证 append 新消息后的“滚动到底部”不会被随后到达的
真实高度覆盖。

目标尚未进入当前 Layout 时，物理层返回“需要 jump”，但仍保留最新的目标 ID 与 alignment。
调用方据此发起 re-bootstrap 后，该命令不会随旧 Layout 一起丢失；目标进入 live track 时，物理层
必须再以真实 DOM rect 完成一次最终对齐。Core 在 candidate 激活时产生的数值 correction 负责语义
位置与连续性，不能替代这一步命令式物理对齐，因为真实组件高度和异步内容可能继续变化。

显式对齐读取目标 live row 的真实 border rect，而不是假设 Core 中尚在异步收敛的累计 extent 已经
等于当前文档流。若同帧刚写过 correction，对齐前必须重新读取 correction 后的 host metrics；不能
把新 rect 产生的相对 delta 加到帧开始时的旧 `localScroll`，否则会把正确落点重新拉回靠近顶部。

## 8. Layout Revision ACK

核心每次会影响布局集合或位置的变化都产生新 revision。物理层提交时同时给出：

- 它基于的 revision；
- 确实存在于 DOM 的 handle 集合。

只有 revision 仍是当前值且所有 handle 属于当前主片段时 ACK 才成功。失败意味着物理层应重新读取
快照并 reconcile，不能假设旧提交有效。Committed 集合可用于释放和诊断，不代表 Resident。

## 9. 应用 Scroll Correction

DOM 读取 correction 后：

1. 重新测量 surface 在宿主滚动坐标中的 offset；
2. 将局部目标换算为 host scroll 坐标；
3. 用 instant 行为写入 scrollTop；
4. 立即或下一帧重新读取 host metrics；
5. 把修正后的值回传核心。

Correction 是绝对局部目标而非 delta，避免 surface offset 同时变化时叠加错误。读取动作会消费该
correction；如果调用者取走但不应用，核心会等待错误的 ACK，因此只有物理执行层应读取它。

## 10. Focus 与 Pin

当 activeElement 位于即将离开 Layout 的行中，DOM 层把该行 pin，保持节点身份和焦点。焦点移出
后 unpin，下一次 reconcile 才可卸载。重排行节点前可记录焦点路径/selection，并在必要时恢复；
使用同一节点 `appendChild` 通常能天然保留焦点，但浏览器差异仍需 E2E 覆盖。

## 11. React Portal

React 不能安全地让外部 DOM 执行器任意移动它直接管理的列表子树。适配层因此建立稳定行 shell：

- DOM 层拥有 shell 的创建、位置、移动和销毁；
- React 用 portal 把 item 内容渲染进 shell；
- shell handle 同时作为 portal key；
- shell 移动不重建组件，局部 state 得以保留；
- item 对象更新只刷新 portal 内容，不改变 shell 身份。

## 12. 常见错误

- 用 CSS scroll anchoring 与框架补偿同时工作：会双重修正，应关闭 surface 的原生 anchoring。
- Staging 宽度不同：首次测量无效，激活后闪跳。
- cloneNode 后提交：节点、焦点、React state 全部丢失。
- correction 后未 setView：核心停在屏障或产生错误窗口。
- sticky 已占位又传 padding：可见范围被重复缩小。
- element host 未减 clientTop：所有定位恒定偏移一个边框宽度。
