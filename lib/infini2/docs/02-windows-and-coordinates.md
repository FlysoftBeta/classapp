# 窗口、坐标与空白区

## 1. 术语总览

Extent-based window 是像素区间上的逻辑视图。它们不要求同层实现，也不要求都是具体对象。

```text
scroll surface
|<-- Blank before -->|<--------- main island --------->|<-- Blank after -->|
                      [     Layout window      ]
                             [VisibleWindow]
```

Main window 是遮挡补偿概念；VisibleWindow 是真实可见视口；Layout window 决定挂载和测量；
Blank Zone 让开放边可滚动；Scrollable window 是浏览器看到的完整滚动表面。

## 2. Main window：遮挡后的阅读区域

固定顶栏和底栏不占文档流位置，会遮住滚动内容。调用者通过 `paddingStart` 与 `paddingEnd`
告诉 Infini2 两端的不可见 inset。它们不一定真的写成容器 CSS padding；重要的是效果：

```text
physical viewport = top inset + VisibleWindow + bottom inset
```

规则：

- 固定或 absolute overlay 应计入 inset；
- sticky header/footer 若仍在正常文档流占位，不得重复计入；
- inset 必须是非负像素；
- 两端之和大于 viewport 时，可见 extent 截断为 0；
- inset 变化是几何变化，必须走锚点补偿。

## 3. VisibleWindow

VisibleWindow 是扣除两端 inset 后真正可见的区间，也是滚动进度、水位线和滚动补偿的基准。
在主 Island 的局部坐标中：

```text
visibleStart = effectiveScroll - islandOrigin + paddingStart
visibleEnd   = visibleStart + max(0, viewport - paddingStart - paddingEnd)
```

`effectiveScroll` 在没有待应用补偿时等于最近一次物理 scroll；存在待应用补偿时等于补偿目标。
这可防止同一 frame 在旧 scrollTop 上重复调度请求。

VisibleWindow 可以部分或完全落在主 Island 外。落在相邻空白跑道不一定立即变成离散滚动，
见第 6 节。

## 4. Layout window

Layout window 是 VisibleWindow 向前后扩展的像素范围：

```text
layoutStart = visibleStart - layoutBefore
layoutEnd   = visibleEnd   + layoutAfter
```

未指定时，两端各默认一个当前 viewport；也可显式传固定像素。只有与该范围相交且同时属于
Resident 的 item 才需要进入当前布局集合。它承担三项职责：

- 提前挂载，提供类似 overscan 的抗白屏能力；
- 把估计 extent 替换为真实测量；
- 给 Resident 提供动态基础范围。

Layout target 是核心当前要求的集合；Layout committed 是物理层对某个布局 revision 和实际
已提交 handle 集合的 ACK。旧 revision 的 ACK 必须拒绝，避免晚到 DOM 操作覆盖新状态。

## 5. Bootstrap 的覆盖约束

首次 bootstrap 或离散 seek 的响应不能逐个直接显示。响应先形成 candidate，只挂载目标
Layout window 内的 item 到隐藏区域并测量。只有满足以下任一条件才允许激活：

- 实测 candidate 足以覆盖 VisibleWindow；
- 两端都 exhausted，证明全部内容本来就不足一屏。

“内容不足但至少一端仍 open”是 Provider 违约，因为提交后用户会看到未解释的空洞。
Re-bootstrap 期间旧主内容继续可见，candidate 的半成品不替换它。

## 6. Blank Zone

每个开放边提供固定 `20 × viewport` 的可滚动空白。边 exhausted 后对应空白立即为 0，且几何
变化必须补偿。20V 是框架策略，不作为业务配置，目的是让快速滚动有足够跑道，同时避免把
未知内容伪装成无限精确距离。

Blank Zone 分两段理解：

### 6.1 Blank Resident Zone

紧邻主 Island、在一个 VisibleWindow 距离内的空白仍属于连续滚动。用户的目标仍靠近已知
边界，系统通过普通 edge fetch 递推扩展主 Island，不调用位置预测服务。

### 6.2 Blank Predict Zone

水位线越过相邻跑道后，已经无法由已知 item 精确递推。系统按：

```text
estimated item offset = signed blank distance / default item estimate
```

估计一个离散偏移，然后执行 `locateOffset -> bootstrap -> hidden measure -> commit`。这个偏移
只是给 Provider 的定位提示，不会成为永久全局 index。

## 7. Scrollable window

浏览器实际滚动表面的 extent 为：

```text
blankBefore + mainIslandExtent + blankAfter
```

主 Island 的物理原点等于 `blankBefore`。Item 的局部 start 加此原点才是 surface start。
空白长度变化、主 extent 变化和 surface 自身在宿主文档中的位置变化都可能影响物理坐标，
因此 DOM 层每次写 scrollTop 前应重新测量 surface offset。

## 8. Window 宿主坐标

当滚动宿主是浏览器 window：

```text
surfaceOffset = surface.getBoundingClientRect().top + window.scrollY
localScroll   = window.scrollY - surfaceOffset
viewport      = window.innerHeight
```

当宿主是 overflow element：

```text
surfaceOffset = surfaceRect.top - hostRect.top + host.scrollTop - host.clientTop
localScroll   = host.scrollTop - surfaceOffset
viewport      = host.clientHeight
```

必须扣除 `clientTop`，因为边框不属于滚动内容坐标。忽略它会让有 border 的容器发生稳定偏差。

## 9. 数值归一化

- 非有限 scroll 回退为 0；
- viewport、inset 和 layout overscan 截断为非负；
- window end 不得小于 start；
- item extent 必须为有限正数，否则使用默认估计；
- 微小于布局测量误差的差异可以用 epsilon 忽略，但不能把累计误差写入顺序模型。

## 10. 例子

viewport 为 800px，顶部固定栏 64px，底部固定栏 48px，默认 overscan：

```text
Visible extent = 800 - 64 - 48 = 688px
Layout extent  = 688 + 800 + 800 = 2288px
每个 open edge 的 Blank Zone = 16000px
```

若当前主内容总高 5000px，两端开放，则 surface 总高为 37000px，主内容物理起点为 16000px。
这些物理空白只表示可滚动预测范围，不表示服务器上恰好有对应高度的内容。
