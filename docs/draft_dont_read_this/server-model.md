## 新的 Server-side 模型

当前的 Server 模型是：

Transport -> Action -> Facade/ActorFacade -> Policy -> Service -> Data

现在我决定进一步细化、澄清并约束 Facade/ActorFacade -> Policy -> Service 这个链条。

1. 请求内实例复用

单个请求内，可以复用的东西有

- Database Connection: 现在用的 SQLite 可以选择进行并发读
- Principles(in Service): Actor 的角色/capability/是否在某个群里等请求级事实
- Service

对于 Principles:

- 用在什么上: 是 Service 级 (隶属于 Request) 级别的缓存/lazy loading，适用于在请求期间产生变化也不影响正确性的机制（同理，也适用于请求内必须保存不变的东西）。
- 什么情况下不用: 大多数情况下不会被复用的、可能存在显然一致性问题的不应该做成 Principles。
- 属于实现细节，生命周期绑定 Request/Service: 合理的设计应该让相关的 Service 内接口就承担了 invalidate 的作用。Service 间的抽象应该屏蔽这种缓存机制。例如，一个 Service 做 CRUD，那么 CRUD 的处理中也会一并管理缓存。
- 获取什么：可以一次性抓取常用 columns。
- 需要考虑读己之写问题。

分析方法示例，对于 Role:

- 我不关心: 如果我的 Role 在请求期间突然变化会怎么样 -> 不涉及正确性
- 什么时候用: AuthorityService 可能内部存在反复检验同一事实的代码，这时不一定要对同一事实反复进行多次 SELECT，用 Principle 刚好合适；换个角度想，我不能接受请求前面成立，后面就不成立了；我也不想加锁。
- 怎么呈现：对外呈现 getter/setter（不一定是读或赋值，这里只是广义指读写）形式。
- 获取什么：Role 与 id 等常用的一并读取。

2. Facade, ActorFacade 与 Service

Service 是一个逻辑上独立的机制系统的划分。如果两套机制很正交，那么大概率它需要拆分成两个 Service。

我的理解是，一个系统内部互相依赖是很正常的。Service 很多时候是业务语义表示，也不是什么生命周期的表示。生命周期都是统一绑定在 Request 层面。为什么这么说呢？因为系统内部存在很多操作客观数据结构的 API。例如，article.create... 不会关心你是否在那个群内。

因此，ActorFacade 就负责把两个 Service Wire 起来：通过 group service 判断是否在群里；再通过 article create 创建。Facade 则是无需 Actor 的版本。

也就是说，业务逻辑不是都在 Service 里（不是只是一个 wrapper/glue）；而是有一部分在 ActorFacade/Facade 里。Facade 不是直接调用 Service 的逻辑，也不是 1:1 映射，而是业务逻辑的入口开端。Service 也不应该到处都是鉴权代码。很多时候，我们达成一件事情的方法有很多，例如删贴存在两条路径：管理员强删与用户自己删除。如果删除是其他更多请求路径的一部分，那么难不成我得在 Post Service 加入更多的鉴权逻辑？

最终类比：

- Facade/ActorFacade 有点像是 public APIs。
- 光是 Services 这种 lib 内部是可能组合出非法状态的。

但是！什么应该放在这个 ActorFacade/Facade 里呢？适合放 Actor 与业务相关的逻辑，一般就是 Authority 逻辑了。

3. 新的 Authority 架构（广义的，管所有需要授权的东西，**不是一个具体的架构**，而是解决一个业内共有的基础的**问题**）

目前的权限模型非常扁平：`admin` 基本只是一个 feature flag。对于早期的小规模使用，这足够简单，也足够有效。
但接下来情况会发生变化。由于经常出现管理员滥权，且最近新增了 AI 功能需要有人管充值，不是所有管理功能都能靠一个“管理员”来解决。我们需要支持更细粒度的管理 (目前暂时没有支持分层治理的计划)。

最自然的做法似乎是引入 capabilities，因为它足够灵活，能组合出很多状态空间：定义一组诸如 `post.add/remove@scope` 的 capability，再把它们组合成 role template。但我意识到，capabilities 的概念本身就是把“权限”物化了，通过定义严格的授予、撤销、组合、继承、克隆的规则，capability 实际是一个 Type-safe 的 DSL。

这实际上是在做一件很奇怪的事情：**先设计一门不图灵完备的权限语言，再强行用它描述本来可以直接由程序表达的业务规则。**我能理解这是为了可形式验证性与通用性，但是我这个平台它并不太需要通用（它不是个论坛系统，可以被不同的人部署），也不需要可验证性。况且，需要形式可验证性，我们明明有更多选择。

因此，我倾向于，在 Facade 里，直接表示鉴权逻辑。requireRoles(["a", "b", "c"]) / group isMember 这种可以直接写。它不会污染核心的业务逻辑（在 Service 里），且足够灵活。如果需要更复杂的鉴权逻辑，创建对应的 Service 就行。例如，Group 何尝不是一种“鉴权”？AI 额度管理不也是某种程度的鉴权？这些都值得单独开一个 System。

4. 其他现有实现上的问题

- feature mask 这种用 bitset 只应该是一个实现细节，用于压缩 SQLite 的 schema。现有的却把它当作客户端与服务端交流的一部分。这样是没法执行新的 Access Control 的。大多数地方，应该就是个 boolean。feature mask 可以支持很多互斥的东西，比如 discriminated unions（类似 Rust 的 enum 实现，需要 tag，且 body 大小对齐）

5. 新的分层

因此，新的分层是：Transport -> Action -> Facade/ActorFacade -> Service -> Data。

- 其中，Transport 与 Data 与 Action 负责隐藏较脏的 Transport Protocol, SQL 语句, Schema 验证。
- Facade/ActorFacade -> Service 则是偏业务的一部分

## 具体的策略设计

### Roles

新增多个 Role。Role 之间正交（部分是包含关系，必须先启用一个再启用另一个）。

- 管理员，必须有这个才能有下面的。
- 根管理员，分配 Role
- 运维 (Incidents/HTTPS 升级/数据库备份)，用于保障服务器功能的完备性
- 功能管理 (feature flags/AI credits与 AI 套餐管理)
- 协助运营 (锁定设置，便捷工具)
- 准入管理 (Client 管理/新建用户/幽灵用户)
- 社区管理员 (Ban/Mute/Reset password/直接删除 Posts 与 Articles/创建群聊/查看用户、群组信息)（注意，移除统一查看 Posts 的功能）
- 高级社区管理员 (删除用户/改个人信息/改群组信息/强行加入群组/公告)

### AI 计费

AI 计费需要新的策略驱动：

- 引入日额度与周额度机制（day * 5 >= week，不算周六日）。这些不直接显示为 credit，而是显示百分比。给多少可以由功能管理员统一设置。功能管理员设置套餐持续时间。(默认 100 credit per day, 300 credit per week)
- 额外 credit top-up。

值得单独做一个 Service。（提醒一下，现有的 credit 系统有 bug，扣的太多了；我是希望 100 credit = 1 CNY）

需要一个统一聚合的地方，显示系统内 credit 存量（按周额度 + 额外 credit 算）与实际消耗的 credit（每日）。

### 管理员面板 UI/UX

需要你推倒现有的管理员面板，重新设计。

现有的设计存在以下问题：

- 样式与布局存在大问题。不同 tab 里样式不统一；
- 帮助文本没有解释好机制。需要系统化的解释，但是不偏实现细节，只关注于大概怎么工作，怎么用它。
- 操作逻辑混乱，有些地方可以批量，有些不行；目前只能批量应用 features。
- 展示逻辑混乱，有些是 badge 有些又不是；有些地方信息密度很低。
- 超级大的表格实现不完善：没有对长 text 的折叠与展开的支持（例如那个 UA 非常长）；左右滚动布局有问题；不能选择列；左侧 ID 类表头没有 Sticky header；没有支持虚拟滚动。
- 与新的思维模型基本上不适配。

你可以想一些新的 UX 上的 metal model 出来。

## 要求

- 为了表达设计语义，我提供的都是简化示例，不要照着我随便编出来的东西来。
- 尽量不要参考现有的实现，它们都是 poorly implemented 的。我正是希望你能推翻这些糟糕的设计与代码。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见。
- 改动不限制 scope，客户端与服务端一起改。
- 我希望得出一套干净的设计，把能改的地方都改好，避免反复返工，减少未来的困扰。
- 一边编写实现，一边写文档。文档最好对每个 Service 有一个系统化的视角。此外，还需要将上述设计写成文档，可供反复参考。
- 编码习惯方面，写零零散散的 helper function 时，请给他们分组；请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。

先评估这套方案。
