ClassApp 目前的权限模型非常扁平：`admin` 基本只是一个 feature flag。对于早期的小规模使用，这足够简单，也足够有效。
但接下来情况会发生变化。ClassApp 需要支持更复杂的管理需求，例如：

- 细粒度的管理；
- 灵活的 AI 配额与计费方案；
- 未来可能出现的分层治理。（目前没有这个需求）

因此，引入新的 authority 架构已经不可避免。

最自然的做法似乎是 Capability Model：定义一组诸如 `content.manage`、`user.manage`、`ai.billing` 的 capability，再把它们组合成 Role。但仔细想以后，我认为这并不是 ClassApp 最合适的方向。

Capability 最大的问题是：它把“权限”物化了。一个业务规则原本可能只是一个普通命题：

```ts
canDeletePost(actor, post);
```

它表达的是：在当前业务状态和治理规则下，这次操作是否合法？

但 Capability System 会进一步把这个命题提升成一个 **Handle**（一个对象），而一个 Handle 可以被存储、授予、撤销、组合、继承，克隆。于是，“是否允许执行某件事”不再只是代码计算出的结果，而被物化成了一种可以被持有的对象。这导致我们需要定义一整套规则（很有类型论的味道！）。

这实际上是在做一件很奇怪的事情：**先设计一门不图灵完备的权限语言，再强行用它描述本来可以直接由程序表达的业务规则。**

我认为这种东西纯属简单问题复杂化。

## 但 Policy 和 Mechanism 仍然应该分离

“Policy 使用代码”并不意味着把各种：

```ts
if (admin) ...
```

重新散落到业务代码里。

ClassApp 仍然应该把 **机制** 与 **策略** 分开。

机制层负责**提供稳定的事实**，例如，提供 User A 是否属于 Group B 的原语（这里由 Service 层提供）。

Authority 则可以按照业务需要设计一个决策内核，**组合这些原语**。决策层甚至自己都可以是一个 Service，因为**决策也可以有状态（看需求，例如你用了什么套餐）**。

## 最终分层

Transport -> Action -> Facade/ActorFacade -> Authority（原 Policy） -> Services

其中，Facade/ActorFacade 有点像是一个库的 public APIs。如果光是 services 内部是可能组合出非法状态的。

Authority 会针对一类 API 做 can* 系列接口。can* 需要合理划分，例如 Client 增删改查就只需要分成一个就行了。

Authority 也可以是一个或多个 Services。这只是一种逻辑的分层，并不是严格的分层，因为 Authority 真的也可以是一个独立工作的系统。

## 具体的策略设计

Role 依旧以 feature flag 的形式出现，不过 Role 有更多：

- 运维管理员 (incident/https/update)
- 功能管理员（feature flags/AI credits与套餐管理）
- 准入管理员 (client 管理/新建用户与幽灵用户)
- 社区管理员 (ban/mute/reset password/查看Posts/删除消息与Posts)
- 高级社区管理员 (removal/改个人信息/强行加入群组)

AI 计费：
AI 计费需要新的策略驱动：

- 引入日额度与周额度机制（day * 7 <= week）。这些不直接显示为 credit，而是显示百分比。给多少可以由功能管理员统一设置。功能管理员设置套餐持续时间。(默认 100 credit per day, 400 credit per week)
- 额外 credit。
  值得单独做一个 Service。（提醒一下，现有的 credit 系统有 bug，扣的太多了；我是希望 100 credit = 1 CNY）

UI/UX: 需要你重新设计管理员面板（现在的设计很乱，很丑（布局很差），很不直观（帮助文本不恰当），也还没有适配新的模型）。
我是希望复杂的数据表，可以选择列，可以横向滚动，可以接入 sticky header，可以统一支持批量操作（而不是现在这种半吊子形态）；左边的表头可以保持sticky.

## 要求

- 尽量不要参考现有的实现，他们都是 poorly implemented 的。我正是希望你能推翻这些糟糕的设计与代码。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见。
- 改动不限制 scope。
- 编码习惯方面，写零零散散的 helper function 时，请给他们分组；请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。

先评估这套方案。
