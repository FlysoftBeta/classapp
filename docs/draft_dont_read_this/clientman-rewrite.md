不要参考现有的客户端实现，完整重写客户端本地数据管理系统。

为什么不要参考：

- 目前的 resourceManager 等文件本身设计非常糟糕。例如 IDB 连接永不释放。
- app/session 的状态管理也可以说做的一眼难尽...
- 数据拉取仍然需要每个使用处进行手动判定。

重点不是我列举出来的问题本身，而是现有实现本来就很糟糕，根本没有什么好参考的。逻辑设计不要被它带偏了。

处理方案：客户端的数据可以随时重建（classapp-runtime）升到 schema = 3 后就删原来的库就行了，不重要。别为他写迁移，不值得浪费时间。

A. IDB 层面的设计：

一、文件存储 (files)
特点：

- 索引方式是 KV 型，不是完整的文件系统
- 操作目标就是二进制
- 提供 grow, shrink, read, write, delete API，在上面封装高级 API，用于 Seek, streaming 等高级用途。

这里的文件其实就是大二进制 blob

实现要点：

- key: id, extent。id 为 string，extent 为 zero-based 的连续标号。
- extent 的数据用一个 <= 4MiB 的 ArrayBuffer 存 (只有最后一个 extent < 4MiB 是合法的，其他必须 = 4MiB，shrink 不能从内容中间收缩)。
- **一定不要用 Blob。Blob 在项目的目标浏览器 M70-80 有 bug。** 用 ArrayBuffer
- 一个 extent 不能携带多余的 metadata，因为底层的 LevelDB 写 row 是会写入所有字段的
- 避免一个事务中进行太多操作，这样易出现内存尖峰。

二、领域数据存储 (domain_groups, domain_dms, domain_posts, domain_articles, domain_users, domain_me, domain_me_article_state, domain_me_conv_state, domain_me_state, domain_save)

**什么应该包含进来的设计原则：**

- 客户端领域数据仅反映客户端能看到的数据。
- 客户端领域数据应该允许不完整。
- 客户端领域数据不需要包含服务端决策的数据。离线下本来就不能做出多少决策。
  最简单的例子：

1. Groups 领域没必要包含群组密码，一是我们本来就不能让客户端看到密码 hash，二是我们无法在离线下代替服务器做加群决策。
2. 一个群组是否能发言的 flag，直接照搬服务端返回的状态。并不需要关心是什么导致了这个设置开启。
3. 由于我并不知道其他用户的设置是什么，所以对于我登录过的，就在 domain_me 里（包含设置，如暗色等）。其他我只关心 (id, handle, name) 的扔到 domain_users 里

**结构设计：**

- 如果一个列表没法增量获取，没必要弄成一个单独的 db table。例如群成员列表没有明确的服务端 revision 机制，要发生拉取就整个一起更新，那么就搞成一个 JSON list value，放在 domain_groups 里面的一个 field 就好了。
- 其他的则需要设计同步逻辑。例如，对于 Posts 的不变量就是，保留的必须是一个连续的区间。
- 客观状态不应当与用户绑定。也就是说两个帐号拥有共同群聊，消息只存一份，且双方都能享受到最新的消息。
  离线下的整体逻辑是这样：全局设置了当前登录的 user -> 用 user 视角看能访问的各种资源，并带上 user 的个性化设置等，总之，就是结合 user 自己的情况 -> 全局客观资源
- 数据模型可一定程度参考 docs/data-model.md，这是**服务端**的数据模型。

**客户端离线决策保存与合并：**
domain_me_article_state/domain_me_conv_state/domain_me_state 需要存放：

- 做出这个决策的用户 (我是谁)
- 客体（me_state 可以没有），例如 conv_id，article_id

什么是用户决策：

- user_config, convs_user, article_read_progress 下面的 do not disturb, theme mode, unread, read_progress 都算是用户能在离线做的决策。（翻页，读消息这也算）

其中，对于每一个 tweakable 选项：

- 原始数值
- 提议（可能是 assign, 还可能带 timestamp，视语义而定）

不同类型的数值，处理这二元组的方式还不太一样。

- 比如，对于赋值型的，提议就是新的选项+时间戳，客户端与服务端之间采取 LWW
- 对于 unread（未读消息水位线）/read_progress，提议就是新的 cursor。客户端与服务端之间谁的 cursor 更靠后选谁。（在线状态下还是采用 override 的方式，这样用户仍然可以向前滚动）

**淘汰设计：**
quota 可能会满。需要清理客观资源。

UI/UX 上，用户可以设置一个资源的保存策略。例如，对于聊天功能，可以设置至少保存多久内的所有消息；对于文章，用户可以设置这篇文章至少可以离线看多久。

表的设计上，为了简易，是整个设备共享的，但是不会同步到服务器。

触发条件上，对于客观资源，当 navigator.storage.quota 不足 90 时，执行清理直到 quota 到 80。必要时，会淘汰用户设置的东西。

三、杂项
globals 存放全局状态，就是简单的一个 kv：

1. 当前活跃的 me
2. 当前活跃的 bundle

bundles 存放 (build_id, entrypoint_code: ArrayBuffer, installed_at)。shell.html 负责 bootstrap，需要懂得最基本的设置 globals.active-bundle 并 put bundles。

B. 代码组织

分几层，请注意**职责分离**:

- client/data: 负责直接与 raw IDB 交互。按照 Separation of mechanism and policy 的设计哲学，Data DB 需要辅助高级语义的表达，比如能够表示什么应该原子化提交、某种策略的实现是否需要某个特殊的 column 或 index。
- client/interact: 负责 wire data 层与 server API。你需要把目前散落在 React 内部各处的 Pick online or offline 的逻辑移动到这里。此外，它也拥有 RemoteManager。简而言之，负责把要做什么转化为怎么做。要获取文章列表 -> 只有有限的本地版本 -> 显示。它就是客户端业务逻辑新的核心。代替 client/app 下的功能。

C. 要求

- 尽量不要参考现有的实现，他们都是 poorly implemented 的。我正是希望你能推翻这些糟糕的设计与代码。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见。
- 改动不限制 scope。虽然主要改的是客户端，其他也能改。
- 编码习惯方面，写零零散散的 helper function 时，请给他们分组；请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。

先评估这套方案。
