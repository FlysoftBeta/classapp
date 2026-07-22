# 不变量清单

本页用于设计评审、代码评审和回归排查。

## 身份与顺序

- [ ] Stable ID 唯一、永不复用；移动使用新 ID。
- [ ] 单个 page 内无重复 ID，始终为 content order。
- [ ] 已确认相对顺序不可改变。
- [ ] 0 只作为 invalid sentinel，不分配给 item/island/effect。
- [ ] Tombstone 不被迟到 response 复活。

## 窗口与几何

- [ ] VisibleWindow 扣除两端 inset，sticky 流内占位不重复计算。
- [ ] Layout = Visible + 两端像素 overscan。
- [ ] 每个 open edge 恰有 20V Blank；exhausted edge 为 0。
- [ ] 邻近一个 VisibleWindow 的 Blank 仍走连续 fetch；更远才 seek。
- [ ] Surface extent = before blank + main extent + after blank。
- [ ] Element host 坐标扣除 clientTop。

## Resident 与 Buffer

- [ ] Resident 从 Layout 命中动态计算，再按 item 数延伸。
- [ ] Buffer 只是 Resident 外已知内容标签，无独立容量或 generation。
- [ ] 相关 Buffer 非空时不得再次 fetch。
- [ ] Trim 与加载语义分离，只删 Resident 外端且不越过 pin。
- [ ] Resident range 仅为订阅优化，不成为正确性依赖。

## Island

- [ ] 最多一个 main、每方向最多一个 Stale。
- [ ] 未合并 Island 之间始终 unknown。
- [ ] 公共锚点在两侧 rank 严格同向递增。
- [ ] 冲突段 main 胜出；main 为空段才由 Stale 补齐。
- [ ] 顺序冲突直接丢 Stale，不做版本/内容猜测。
- [ ] N 次相关成功加载无锚点后直接删 Stale。

## 异步工作

- [ ] 每个任务独立携带 owner、方向、anchor 和 journal 起点。
- [ ] 不使用全局 generation 一刀切拒绝旧结果。
- [ ] Detached 成功结果可存 Stale，失败不改变当前可见 phase。
- [ ] Owner 合并后旧 edge result 可重定向验证。
- [ ] Provider 取消只是优化，正确性不依赖 abort 生效。
- [ ] Mutation journal 按通知顺序重放。

## 测量与补偿

- [ ] Candidate 先同宽隐藏挂载、测量，再移动同一 DOM tree。
- [ ] 普通 Layout 新行也先进入 staging；未测量行不进入 live/committed 集合。
- [ ] 连续 live 行共享一个 track transform，行 shell 本身保持正常文档流。
- [ ] 一个 animation frame 最多一轮 Layout 提交，不做写后同步多 pass settle。
- [ ] ResizeObserver 使用 entry 的 border-box 尺寸，不重新读取 live row rect。
- [ ] 开放 candidate 必须覆盖 VisibleWindow；短内容必须双端 exhausted。
- [ ] Candidate 激活时先完成 Stale 合并，再按最终 Main 序列恢复 target alignment。
- [ ] 同一 frame 的几何变化共享 anchor。
- [ ] 待应用 correction 参与窗口计算，并屏蔽旧 scroll 调度。
- [ ] Correction 写入后必须 setView ACK。
- [ ] Layout commit 必须携带当前 revision 和精确 handles。
- [ ] 删除 anchor 选择后继或边界 fallback。
- [ ] Focus 行 pin，失焦及时 unpin。

## Provider 与错误

- [ ] Response 至少与请求发起时一样新；不要求 revision。
- [ ] 外部通知有序、不遗漏、允许异步、最终到达。
- [ ] 空 edge page exhausted 相关方向；空 bootstrap 双端 exhausted。
- [ ] targetSize 按像素覆盖，Provider 尽量足量。
- [ ] Failure latch 防止自动重试风暴；retry 保留原 intent。
- [ ] 背景错误上报但不覆盖可用前台状态。

## 生命周期与构建

- [ ] Dispose 幂等，断开监听/observer，忽略迟到 Promise。
- [ ] React StrictMode replay 不泄漏或误销毁。
- [ ] Wasm 无 imports 且内联进单一 bundle。
- [ ] 新公开 API 有 JSDoc/rustdoc、设计说明和测试。
