# Extent-based window(s):

按大小计算的窗口概念。这些只是逻辑分层，实现上不一定在同一层，也不一定以窗口的形式出现，想实现的是**效果**。

## Main window

1. 实现为 paddingStart/paddingEnd，用于抬高内容以免被顶栏/底栏遮挡。
   对于 Sticky header/footer，这种在文档流会占位，则不需要额外增加占位。
   padding 设置主要解决滚动容器中，文档流存在混合内容时，滚动补偿的处理。

2. 或者，实现为一种特殊占位 item，这样通用性更强，
   但是需要对 Sticky header/footer 这种 **always mount**（不会随着滚动卸载而消失） 的 item 给予特殊支持。

该窗口给滚动补偿提供 Viewport 相关信息。

## Render window

真正的传统**视口（Viewport）**概念。Render window 内的物品会真正发生渲染。
例如，滚动补偿需要用的 scrollTop 对应的就是 Render window 的顶端为基准点。
大小随着容器大小而决定。

该窗口给滚动补偿与 Layout window 大小提供 Viewport 相关信息。

## Layout window

最大的 Extent-based window（大小相对于 Render window 大几倍/大几个像素）。
只有 Layout window 内的东西会按占位大小计算。
大小随 (Viewport 大小 + 固定倍数或固定像素数) 变化。

元素的挂载与测量在此窗口内发生。

元素先被测量（在DOM语境下需要被挂到 document 中），再一次性提交进来，避免用户看到 flicker。对于 DOM 层，将元素挂载到 DOM 的一个隐藏区域中，并进行 ResizeObserver 观察后(Measure)，直接通过 .appendChild 移动元素所在 DOM tree(Commit)。

选择较大的 Layout window（而不只是 = Render window）有着类似 overscan 机制的效果：
提前挂载元素可以避免滚动速度过快而白屏的问题。

在 Bootstrap 未完成期间，显示一个 Layout window < Render window 的窗口是非法的（除非内容不足）。
一般做法是，在 Init-Bootstrap 时可以不显示任何项目；在 Re-Bootstrap 期间可以保留当前内容显示

## Blank Zone

对于没有挂载的区域，用可滚动的空白代替（且几乎无限）。由于Item未挂载，滚动进度用 (已滚动距离 / 估计的单 item 大小) 进行估计。
此时会发起一个与 jump 很类似的路径（先 async fetch (如果需要的话)，再跳转）
与 jump 不同指出在于，jump 是命令式的，而这条路径符合异步 Work loop 流程（见 Work loop）。

- 在 Resident window 之内的区域称为 Blank Resident Zone，仍属于连续滚动。
- 在 Resident window 之外的称为称为 Blank Predict Zone，属于离散滚动。

## Scrollable window

Layout window + Blank Zone

# Length-based window(s)

以 item 数量定大小的窗口概念。

## Resident window

客户端目前能看到的内容，一般指的就是 Main Island。

## Content window

所有内容的全貌，纯逻辑概念，其存在体现于 exhaustedStart/End 概念的设计：上方、下方是否还有内容呢？

对于部分场景，这个概念始终不存在：例如社媒信息流，没有顶端或底端，内容是动态无限生成的。

客户端一般看不到内容全貌。

# Residency

控制数据加载策略。

Layout window 用大小来框住元素，而 Resident window 则是以 Layout window **框住的元素为基准**，向外**按元素数量**延伸 N 个元素。

一个经典问题：

- Resident 内如果用硬 cap 上限，当出现缺 Item 的情况，会拉取 Items；
- 如果我们没法控制拉多少 Items，则可能一次拉取（Request）的一部分会纳入 Resident，而另一部分为了满足硬 cap 而被直接截断去除；
- 此时如果再次向这个方向加载，又会拉取一部分之前已经拉过但被去除的内容；
- 一个不太灵活的解决办法是，将一次拉取（Request）拉取的内容包装成一个 Eviction-atomic，要去除一起去掉。

要解决这个问题，可引入一个概念：Buffer。

- Buffer 没有大小，但 **Resident window 有固定容量**
- 为了填满 Resident window，可能会发起一些拉取
- 向该方向拉取可能产生多的元素，存入 Buffer
- 在这个方向下次发生拉取前，该方向 Buffer 必须耗尽

# Residency：多岛管理

有两种 Island: Main Island 与 Stale Island；未来可能会根据预载需求增加 Predict Island（例如这里有一个跳转到消息），目前不添加。

```
[unknown] [stale island 1] [unknown] [main island] [unknown] [stale island 2] [content end]
```

## Sequence 数据结构

需求：

- 频繁插入、删除：用于处理数据加载，需要高效地增量处理
- 片段标记：标记是否为 cache/resident/layout 等
- 片段求和：求 len/extent

原始基于 treap 的实现在 lib/infini/rust/sequence.rs 内有。

## Main Island

## 岛间关系

- Main Island 可能有一个前向 Stale Island 或一个后向 Stale Island，在图中分别为 Stale Island 1 与 2
- 不同 Island 间，只要未发生合并，就始终认为存在一块 unknown 区域
- 岛间关系需要在数据拉取时，活跃地检查是否到达（是否相交），如果相交则尝试执行合并操作

## 有标记性锚点的合并处理

不变量：

- 物品顺序一旦确定，不可更改；如果必须要实现该效果，可用不同 ID 的办法代替
- 外界通知到达可以是异步的，但是抓取的信息必须最新的；外界通知内部多个通知间必须有序，但是外界通知与主动请求之间顺序可以任意
- 每个岛内的元素可以短期内与服务器不一致，但是保障顺序正确性与最终一致性（如下方所述）

```
[stale island 1: a b c A B C D E F] [main island: B G D E H]
```

查找两者公共字串（在一起的会合并），并补全 main island 中公共串周边段（未成为公共字串的部分，即 `a b c A`、`none`、`C`、`G`等等）:

```
[stale island 1: a b c A (B) C (D E) F] [main island: none (B) G (D E) H]
```

以下选择涉及 correctness：

- 如果 island 中的段为 none，选有内容的一方 `a b c A (B)`
- 如果两个段不同，选逻辑上更新的的一方，如 `C` 与 `G` 选择 `G`，变为 `(B) G (D E)`
  Main island 在合并时，使用的是新拉取的数据，一定是最新的，因此必选 Main island

呈现出的效果为：在滚动方向上，可能短暂出现新旧内容混合的现象。但如果外界通知能够正确送达，则最终状态一致。

## 无标记性锚点的处理

在 N 次（可配置）加载中无法选取该 Stale Island，则该 Stale Island 将被移除。

可能无法被选取到的原因有：

- Stale Island 内所有元素在服务端都被移除，但是外界通知未送达，加之新拉取的数据与其完全不重合，导致没有合并用锚点
- 由于某些原因，滚动越过了对应的 Island（这种情况大概率不存在，因为非递推型滚动，即离散滚动，是可以明确被 identified 的）

# Work loop

```
DOM Event (scroll) -> [UI State (是否在 layout window 内，...) -> Filler (manage in-flights) -> UI updates] -> DOM Measure -> DOM apply (.appendChild + .scrollTop in one microtask)

[ ]: Rust core
```

异步请求的处理办法实例（以由 Blank Predict Zone 触发的异步 Bootstrap 为例子）：

```
on scroll -> 处于 Scrollable window 内的 Blank Predict Zone -> 发射链式任务（如果不存在的话；ID+offset 服务端接口 -> bootstrap 拉取 -> ...）

on scroll (第二次) -> 可能直接取消 in-flight 链式任务

链式任务完成 -> 检查当前滚动状态是否还需要这个任务
```

# 外界交互

- 提供外界应该 subscribe 什么范围内的信息（可选）
- 外界向 Infini 描述怎么变的（在哪个元素后插入；删除了某个元素），
  Infini 判断它是否需要这个信息（因为外界可能完全用不着 subscribe 机制，另一个就是外部是异步的，更新可能不及时，等等），
  选择性保留或丢弃（建议不要触发 eviction 那一套了，而是直接在 mutate 前就判断完毕）
  语义要求：消息不可遗漏，但可异步，最终一定会到达
- 外界提供以某个 Id 向前向后 fetch 的 API（可inclusive）；提供 ID 片段间物品数量 API；等等

# 滚动类型

- 连续滚动是递推形滚动，滚动的"目标"在客户端能看到的范围内，Infini 可以递推得到元素对应的确切位置。
- 离散滚动，Infini 则没法递推它对应的位置，中间就需要补一个空白区域。

# 水位线（锚点）

- 避免 viewport 内元素大小动态改变
- 外界可获取当前在看的元素，用于小说阅读进度保存
- 可用于设置 Init/Re-bootstrap 的初始元素的位置

# 整体 Hierarchy

- 平台无关通用 Rust core（滚动补偿与无限滚动、Residency等加载**逻辑**，所有平台无关逻辑都放到这里），未来可能不只用于 web 端
  （注意，现有的 load 层改名为 data 层，更贴切，而且从 TS 迁移到 Rust）
- DOM 层：负责通用的滚动补偿、滚动容器测量与元素 Resize 处理等几何与坐标处理，与 React 生命周期无关，未来可能要接 Vue 等封装
- React 封装：封装成 React 组件 或者 React hook

# 风格与注意事项

- E2E 测试很重要：用 Playwright 但不需要真的发生 user smooth scroll；可通过手动设置 scrollTop 直接测试（毕竟 Work loop 内从来没要求滚动是连续的）；测试对象可以是内部的事件，或 clientTop 这种物理位置
- 单元测试也很重要：基本逻辑排查起来其实蛮恶心的
- 善用 Field 互斥的状态机，尽量避免类型上出现某些不太合法的状态，那样会很难排查
- 进行合理的拆分与抽象，避免出现类似 god object 的问题
- 上述所有抽象概念不必都物化，可以是抽象的视图，甚至没必要抽象为一个具体的 Window 对象
- lib/infini 的部分逻辑存在错误（问题比较多），仅供借鉴

我即将重写现有的 Infini 框架（新目录 lib/infini2），评估一下上述方案？

===

# Work loop

1. 用户进行滚动，滚动状态变化
2. Layout window 从 Residency 中同步拉取 items，挂载并测量；拉不到就用白屏代替
3. Resident window 自身进行异步 fixup（获取无物品填充的白屏那部分对应的 Items？）
4. (我真的不清楚哪里需要做 eviction，因为用户滚动真的充满了未知，这方面你来设计！)

# 离散 Resident window

应该允许如下的示例结构：

```
[unknown] [seg 1 start ... end] [unknown] [seg 2 start ... end] [content end]
```

中间那块 unknown，如果有设置 item id range 转 item 数量的接口，可能可以显示一个估计的大小的白屏，如果用户停在了这个范围内，可以定点打到对应的元素。

可以 merge：

```
[unknown] [seg 1/2 start ... end] [content end]
```

至于怎么 evict 与支持 buffer，你需要帮我想一下。

需要支持增量处理。

# Residency 多离散 Islands 管理

```
[unknown] [stale island 1] [unknown] [main island] [unknown] [stale island 2] [content end]
```

Residency 系统管理多个 Islands：

- 不同 Island 间一定存在一块未知区域
- 主岛会主动根据用户行为进行补全，存在完整的 Buffer-based cache 管理体系
- 主岛按照用户滚动行为拉取并淘汰反方向 Items，始终保持主岛主体部分充满 Items，只是一段连续的 Item 序列

空闲岛的设计是完全 Opt-in 的：

- 空闲岛存在目的是减少对应区域首屏(Bootstrapping)所用请求数，一般认为一次拉取足矣覆盖 Viewport
- 空闲岛采取 best-effort 保留（策略与主岛不同），不会主动进行拉取；空闲岛也受外部通知的影响；剩余元素数量明显小于首屏所需的数量时，该空闲岛失去价值被整个删除

空闲岛在设计上是允许与主岛合并的，然而，由于用户滚动的未知性，我们又很难知道主岛与空闲岛在空间上的关系。
可能存在用户滚动太快而直接错过整一个空闲岛的加载的问题。

Graceful 处理 main island 与 stale island 的合并：

- 主岛需要准确判定其与该方向上空闲岛的关系：未知(=未到达)，部分重叠，或已错位
- Pitfalls：Item 不可变更顺序；外界对删除的通知是 async 的

合并 Correctness 保障：每次向某个方向滚动触发拉取时，Residency 携带该方向上空闲岛最靠近的一个 Item，以此检测拉取的 Items 是否发生重叠或已经错位

- 应当允许：该 Item 无效（如实际已删除而外界主动通知未到达时），此时该岛仍属于关系未知状态
- 重叠时
- 错位时（方向彻底颠倒时），？

编码风格：

- 使用明确的状态机表示不同状态，利用 TypeScript 表示不同 state 下 field 的互斥关系，并在状态转移时显式赋值部分可能共享的 field
- 上述所有抽象概念不必都物化，可以是抽象的视图，甚至没必要抽象为一个具体的 Window 对象

重新设计Infini，将代码放在 lib/infini 内

1. 新的 Window 分层（逻辑分层）：Main window（供抬高内容顶部底部用的，比如顶栏底栏，用于滚动补偿逻辑）-> Render window（在视野内的，用于滚动逻辑）->Layout window（已进行布局测量，甚至是挂在到DOM上的元素[具体实现你自己确定]，想要实现的效果类似 overscan [避免滚动过快白屏]，用于渲染逻辑）->Resident window（已加载的元素所在窗口，用于加载逻辑）->Buffer window（多出的元素放Buffer，用于加载逻辑）->Content window（提供是否需要继续加载的信息，逻辑上的）
2. 注意，新的 Window 分层是逻辑上的，不代表最终实现。如 Main window 与 Render window 的差距，实际用 paddingTop, paddingBottom 表示；Layout window 则用于笼统地表示已经计算出布局的元素（如 React mount 的语义等）；Resident window 与 Buffer window 其实是一种东西，是现有 Hold 概念的延伸，能够更优雅地处理 eviction
3. Buffer-based eviction（代替Request为eviction atomic）：Request 多出的，在 Resident window 下放不下的 Items放入Buffer（Buffer的逻辑大小动态扩展）；如果Buffer内有内容就不触发Request
4. Resident Window 支持分段处理（离散不连续），Eviction 策略也围绕可分段展开
5. 支持增量处理元素，避免 O(n) 开销
6. 支持接受外部信息（框架可选择性忽略）：1）指定元素删除；2）以某元素为锚点向后插入或向前插入
7. 框架职责明确，比如底层的虚拟滚动层只需理解Main window, Render window, Layout window 等，无需在意后面的逻辑Window；而处理数据加载的就需要区分向上加载向下加载与元素变化的区别（比如要graceful 处理 aria-live）；通用DOM逻辑：容器测量、元素测量与提交（通过appendChild移动位置）
8. 改成 Rust 实现逻辑（与Web无关）；写一个 React 封装与裸 DOM 封装（Wasm）；写大量 Headless 测试
