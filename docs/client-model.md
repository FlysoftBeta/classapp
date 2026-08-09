# ClassApp 客户端本地数据模型

本文定义 ClassApp 新客户端本地数据系统。它不是对旧客户端缓存或状态管理的修补，
也不以旧实现的抽象为兼容目标。客户端数据库是服务端数据的可丢弃物化、本设备上
用户决策的持久载体，以及生产 bundle 的启动载体。

设计目标是：

1. React 只表达用户想做什么，不判断在线、离线、是否需要拉取或如何合并。
2. 同一客观实体在设备上只保存一份；不同帐号只保存各自的可见性投影和个性化状态。
3. 局部缓存必须能证明自己覆盖了什么，不能把“有一些行”误认为“列表完整”。
4. 所有离线决定都有明确的合并代数；不依赖请求恰好按顺序到达。
5. 大二进制只以 `ArrayBuffer` extent 保存，写入、流式读取和淘汰不会制造内存尖峰。
6. quota 不足时可以丢弃任何服务端可重建内容，但不丢用户尚未同步的决定。
7. IndexedDB 连接、事务和跨页面并发都有明确生命周期。

## 1. 三类事实

本地数据不能只分成“服务端数据”和“用户数据”。它需要三类事实。

### 1.1 客观实体

客观实体与当前登录用户无关。同一设备上的两个帐号访问同一个群、帖子或文章时，
共用同一份数据：

- group、dm；
- post 的当前权威版本；
- article metadata；
- 公开的精简 user identity；
- article body/file。

客观实体只包含服务端允许任一有权访问者看到的核心字段。服务端决策过程不会被复制
到客户端。例如客户端保存 `can_post` 的投影结果，不保存足以自行推导 `can_post` 的
服务端权限规则。

### 1.2 Actor 投影

Actor 投影回答“用户 X 目前能看到什么，以及服务端为 X 得出了什么结果”。它不是
客观实体，也不是用户决定：

- 用户是否能访问一个 conversation/article；
- 当前用户在群里的 `can_post`、`can_leave` 等能力；
- 对当前用户可见的群成员完整快照；
- conversation directory 中属于当前用户的 membership；
- 某个用户视角下文章列表的 membership 和 cursor 排序值。

任何从帐号 A 获取的 actor 投影都不能供帐号 B 使用。访问客观实体的公开 data API
必须带 actor id；不存在“给我任意缓存帖子”的 UI API。

### 1.3 用户决定

用户决定是客户端可离线修改的事实：

- theme、reader options、do-not-disturb；
- conversation pin/mute/draft/read watermark；
- article bookmark、resume position、furthest-read position；
- 本设备的离线保存策略。

每一个可修改字段独立保存 canonical base 和 local proposal。未确认 proposal 不能因为
刷新、事件、旧响应或帐号切换而丢失。

## 2. 分层与依赖方向

```text
React components/hooks
        |
        v
client/interact public use cases and refresh coordinators
        |                     |
        |                     +--> RemoteManager / server Actions / events
        v
client/data repositories, transactions and store notifications
        |
        v
raw IndexedDB
```

### 2.1 `client/data`

`client/data` 只负责机制：

- 打开、升级、关闭数据库；
- 事务和 IDB request 适配；
- object stores、indexes 和原子提交边界；
- extent 文件；
- normalized rows、coverage、proposal 的持久化；
- 可淘汰对象的候选查询和字节账本；
- 提交后的 store change notification（当前用于触发 quota 检查）。

它不发网络请求，不根据 `navigator.onLine` 做业务选择，也不决定用户应该保留多久。

### 2.2 `client/interact`

`client/interact` 负责策略和编排：

- 唯一持有 RemoteManager；
- 认证 actor 生命周期；
- local-first query、缺口检测、请求合并与重验证；
- response/event normalization；
- reconnect recovery；
- proposal 合并与 flush；
- retention materialization 和 quota eviction policy；
- 向 React 暴露稳定的 use case 和本地优先 refresh coordinator。

UI 不能直接导入 raw IDB、RemoteManager 或 OneShot transport。

### 2.3 React 状态

IDB 是持久领域状态的事实来源。Zustand 中允许保留当前 conversation directory、article
sidebar 这类可重建的展示投影，以及路由、弹窗、选择态；它不能成为第二套持久 cache，
也不能保存 extent 或同步水位。页面刷新后，这些投影必须先从 IDB 重建，再由远端校正。

## 3. 数据库版本和启动契约

数据库名为 `classapp-runtime`。目标 schema 是一个硬边界：旧领域数据不迁移，升级时
直接删除旧 stores 并创建新 stores。

版本号 3 和 4 已经出现在原代码中，浏览器可能打开过它们；继续声明旧版本不会再次触发
`onupgradeneeded`。Bundle Reader 的硬边界使用 version 5。从 version 4 升级时，事务保留
Shell 启动所需的 `globals` 和 `bundles`，删除旧领域 stores 与 Extent 文件，再按本文件
创建空领域 schema；不读取或改写旧领域 row，也没有旧 Blob Reader 的兼容 fallback。
version 3 的 runtime store 结构不同，仍执行全量硬重建并要求首次切换在线。这样既彻底
移除旧文档缓存，又不会在正常的 version 4 → 5 升级瞬间破坏当前 application bundle
的离线启动能力。

TypeScript 入口以 `client/data/schema.ts` 为 schema 来源。`shell.html` 必须能在 application
尚未启动时独立建库，所以无法 import 该模块，只有这一处机械重复；协议契约测试会逐项
校验 version 和 store 名，防止两份声明漂移。

`globals` 只保存：

```text
active-me      -> string | null
active-bundle  -> build id | null
```

`bundles` 保存：

```ts
interface BundleRow {
  build_id: string;
  entrypoint_code: ArrayBuffer;
  installed_at: number;
}
```

安装时先写 bundle row，激活时在一个包含 `bundles` 与 `globals` 的小事务内重新确认
目标 row 存在并更新 pointer。bundle 行不保存冗余的 `active` flag；pointer 是唯一事实
来源。

Shell 只做最小 bootstrap：打开库、读 active pointer、读 bundle、关闭连接、用临时
内存 `Blob` 加载模块。`Blob` 可以作为浏览器 API 的临时适配，但绝不能写入 IDB。

## 4. Object stores

### 4.1 基础 stores

| store        | key                                 | value / purpose                                  |
| ------------ | ----------------------------------- | ------------------------------------------------ |
| `files`      | out-of-line `[physical_id, extent]` | value 必须是纯 `ArrayBuffer`                     |
| `file_heads` | `id`                                | logical id 到完整 physical generation 的发布记录 |
| `globals`    | `key`                               | 两个全局 pointer                                 |
| `bundles`    | `build_id`                          | production entrypoint bytes                      |

### 4.2 客观实体 stores

| store                     | key                          | 关键 indexes                                 |
| ------------------------- | ---------------------------- | -------------------------------------------- |
| `domain_groups`           | `id`                         | unique `conv_id`, `handle`                   |
| `domain_dms`              | `conv_id`                    | `peer_a`, `peer_b`                           |
| `domain_posts`            | `id`                         | `[conv_id, sequence]`, `[conv_id, revision]` |
| `domain_articles`         | `id`                         | `[group_id, created_at, id]`                 |
| `domain_article_segments` | `[article_id, start_offset]` | `[article_id, start_offset]`                 |
| `domain_users`            | `id`                         | `handle`                                     |

`domain_users` 对普通用户只保存 `(id, handle, name)`。登录过的完整用户及其 capability
投影放在 `domain_me`。

Post 的 `(id, conv_id, sequence)` 不可变，body/tombstone 由 `revision` 仲裁。收到较旧
revision 必须忽略；相同 revision 但内容不一致属于 consistency error。

Article core 和 segment 是 immutable。相同 identity 得到不同 core/segment 同样属于
consistency error，不做 LWW。

### 4.3 Actor 和决定 stores

| store                     | key                           | purpose                                      |
| ------------------------- | ----------------------------- | -------------------------------------------- |
| `domain_me`               | `me_id`                       | 登录过用户的 identity、features 和服务端状态 |
| `domain_me_access`        | `[me_id, kind, object_id]`    | 访问资格、actor capability、整体快照         |
| `domain_me_conv_state`    | `[me_id, conv_id]`            | read/pin/mute/draft 的 base + proposal       |
| `domain_me_article_state` | `[me_id, article_id]`         | bookmark/resume/furthest 的 base + proposal  |
| `domain_me_state`         | `[me_id, key]`                | user config 的 base + proposal               |
| `domain_save`             | `[claimant, kind, object_id]` | 本设备 retention claim                       |
| `domain_sync`             | `scope`                       | coverage、revision、snapshot generation      |

`claimant` 默认是 me id。若产品最终选择真正的全设备统一策略，可使用固定的
`"device"` claimant，但不能悄悄让一个帐号覆盖另一个帐号的 claim。

## 5. 文件机制

### 5.1 物理格式

```text
EXTENT_SIZE = 4 * 1024 * 1024
key         = [physical_id: string, extent: non-negative safe integer]
value       = ArrayBuffer with byteLength <= EXTENT_SIZE
```

不变量：

1. extent 从 0 连续；
2. 只有最后一个 extent 可以小于 4 MiB；
3. 非最后 extent 必须恰好 4 MiB；
4. 零长度 logical file 由 `file_heads.size = 0` 表达，不写空 extent；
5. extent value 不含 id、extent、touch time、MIME 或其他 metadata。

### 5.2 低级 API

```ts
interface ExtentFiles {
  size(id: string): Promise<number | null>;
  grow(id: string, size: number): Promise<void>;
  shrink(id: string, size: number): Promise<void>;
  read(id: string, offset: number, length: number): Promise<ArrayBuffer>;
  write(id: string, offset: number, data: ArrayBufferView): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- `write` 不隐式扩容；超出文件大小即失败。
- `grow` 用零填充；先补满旧尾块，再按序追加。
- `shrink` 从最大 extent 向下删除，最后裁剪新的尾块。
- 每批事务只操作少量 extent。`grow`/`shrink` 先把 head 标成 `mutating` 并记录目标
  size；崩溃后读写入口先幂等完成 journal，再发布 `complete`。只有 complete generation
  对读者承诺文件不变量。
- 低级多 extent write 不承诺整次调用原子性。

### 5.3 高级发布 API

整文件下载和替换不能原地覆盖已发布 generation：

```text
allocate staging physical id
  -> sequential extent writes
  -> validate expected size
  -> atomic publish file_heads
  -> retire old physical id
```

读者只解析 `file_heads` 已发布 generation，因此永远不会读到半文件。孤儿 staging 和
retired generations 由 bounded GC 回收。`checksum` 是可选的可信 content identity
记录位；当前服务端未提供 hash，因此实现不伪造一次额外的全文件 hash 扫描。

### 5.4 锁和连接

一个 logical file 的 grow/shrink/write/delete 使用 exclusive Web Lock；read/streaming
使用 shared lock。数据库连接使用 lease：首个操作打开，最后一个 lease 释放后在短暂
idle period 关闭；`versionchange` 和 `pagehide` 立即关闭。

IDB transaction 内不得 await 网络、timer 或无关 Promise。所有 request 必须在事务
活跃阶段排队，事务结果只以 `complete` 为成功。

## 6. Coverage：不完整数据的证明

“客户端领域数据允许不完整”意味着必须表示不完整在哪里。

### 6.1 Post coverage

每个 conversation 保存：

```ts
interface PostCoverage {
  conv_id: string;
  known_revision: number;
  lower: { id: string; sequence: number } | null;
  upper: { id: string; sequence: number } | null;
  reached_oldest: boolean;
  reached_newest: boolean;
}
```

服务端 sequence 是全局有序键，在单个 conversation 内可能有数值空洞。因此 coverage
是“权威分页证明覆盖的 cursor 区间”，不是 `count === max - min + 1`。

普通 page merge 只有在新 page 与已证明边界连接时才能扩展 coverage。孤立 event 可以
更新区间内已有行；区间外新行先作为 live overlay，并触发 revision recovery，不能直接
宣称中间没有漏项。

Recovery：

1. 获取 actor 可访问 conversation 的 awareness revisions；
2. 固定远端 revision 上界；
3. 分页获取 `(known_revision, upper_revision]` 的当前 Post rows；
4. 按 post id/revision merge；
5. 所有页提交后才更新 `known_revision`；
6. 失败时不前移水位，下一次重复是幂等的。

### 6.2 Snapshot coverage

Conversation directory 是 actor 的权威整体快照。提交新快照时，在同一事务内：

- upsert 客观 group/dm/user；
- 替换该 actor 的 access memberships；
- merge 用户状态 base，但保留更强的 local proposals；
- 移除本次 snapshot 中不存在的 actor access；
- 不因一个 actor 失去访问就删除全局实体。

群成员无 revision 时，`[me_id, group_id]` 的成员列表作为整体 snapshot 替换。

### 6.3 Article list coverage

每个 `(me, view, group filter)` 保存自己的 rooted cursor range。初始无 cursor 页面建立
range；之后只有请求 cursor 等于已证明 newest/oldest boundary 时才延伸相应边界。任意
孤立 cursor page 可以缓存实体和 membership，但不能扩大 coverage。`list_sort_at` 只存在
于 membership projection；页面没有出现某文章绝不等于全局删除。

## 7. 用户决定与合并代数

### 7.1 通用记录

```ts
interface Decision<Base, Proposal> {
  base: Base;
  proposal: Proposal | null;
}
```

当前 wire protocol 的 version 是毫秒时间戳；本地使用
`max(Date.now(), previousTimestamp + 1)` 保证单调，并为每次 proposal 生成唯一
`operation_id`。响应合并以 timestamp 和相应领域 comparator 判断，只确认自己对应或
更旧的 proposal，不能清除请求发出后产生的新 proposal。跨设备时钟漂移是现有服务端
协议的限制；若以后需要严格因果序，应该把 wire stamp 升级为 `(wall, counter,
device_id)`，而不是只在客户端偷偷扩充。

### 7.2 Assignment

适用于 theme、DND、pin、mute、bookmark、reader option、draft 和 resume cursor。

```text
stamp 大者胜；完全相同 stamp 时 canonical server base 胜
```

远端 canonical base 总是落库；只有 timestamp 不晚于 base 的 proposal 才会被清除。

### 7.3 Grow-only watermark

Conversation read watermark 和 article furthest-read cursor 采用领域 comparator：

```text
cursor 靠后者胜；cursor 相同则 stamp 靠后者胜
```

Article 必须拆分：

- `resume_cursor`：当前位置，可向前翻页，assignment；
- `furthest_read_cursor`：最远阅读位置，grow-only。

协议显式携带 merge operation：在线交互发送 `override`，允许当前位置向前或向后；
离线 proposal 在重连时发送 `furthest`，服务端与客户端都按 cursor 取更靠后者。语义由
operation 表达，而不是由服务端猜测连接状态。

### 7.4 拒绝与失效

Access snapshot 不再包含某客体时，只撤销该 actor 的 access，不删除共享客观实体。
相应 proposal 保留但进入 dormant：pending 查询会先与当前 access 相交，因此不会每次
重连都向一个无权限客体重试；如果将来重新获得访问，它仍可继续合并。明确的“放弃本地
决定”应由 UI command 删除 proposal，不能由一次网络失败暗中完成。

网络错误保持 pending；malformed/unchecked error 作为客户端 bug 抛出，不能被伪装成
普通离线状态。

## 8. `interact` 查询模型

React 获取的是业务 use case，不是网络和 IDB primitive。当前主要入口是：

```ts
bootstrapSession();
resourceQueries.refreshConversations();
fetchPosts() / resolvePost() / locatePost();
listArticles() / loadArticleForReader() / fetchArticleSegment();
fetchGroupMembers();
readUserSetting() / writeUserSetting();
markConversationRead() / saveArticleProgress();
saveConversationRetention() / saveArticleRetention();
```

这些入口负责：

- 先发出本地快照；
- 根据 coverage/freshness 选择是否请求；
- 合并相同 article page 的 in-flight 请求，并用 refresh generation 隔离过期展示结果；
- 把 response/event 写入 normalized stores 后再生成展示 DTO；
- `navigator.onLine` 只作为提示，Remote connection state 才是主要在线信号。

列表结果本身就是有限本地投影：离线时不要求完整，文章列表会显示所有当前 actor 可见
的缓存 metadata，而不是只显示显式保存的正文。正文是否 materialized 是另一维状态。

需要服务器在线决策的操作，例如加入群组、创建 DM、发送消息，只能由 interact 发起；
离线时返回 typed unavailable，不在本地伪造已成立的服务端事实。

## 9. Reconnect 状态机

```text
disconnected
  -> connecting
  -> authenticating
  -> refreshing-access
  -> flushing-proposals
  -> recovering-revisions
  -> refreshing-snapshots
  -> replaying-events
  -> live
```

连接恢复期间收到的 events 按连接内 arrival order 排队。所有 snapshot/recovery 提交后
再重放，随后才允许依赖增量事件。

每个远端请求捕获 `auth_epoch`。token 变化会递增 epoch、以 checked cancellation 结束旧
pending request、清空
旧 event recovery queue 并使 refresh generation 失效，因此旧 actor 的响应不能落到新
actor 投影中：

- user-specific projection 只能写回捕获的 me；
- actor 已失效时不改变 active-me；
- 真正客观且通过 revision/immutability 校验的数据仍可以安全复用。

## 10. Retention、materialization 与 quota

`domain_save` 保存用户意图，不保存“文件一定还在”的谎言：

```ts
type RetentionClaim =
  | { kind: "conversation-window"; keep_after_ms: number }
  | { kind: "article"; protected_until: number };

interface MaterializationState {
  complete: boolean;
  bytes: number;
  last_touched_at: number;
  missing_reason?: "never-downloaded" | "evicted" | "failed";
}
```

Conversation claim 是滚动窗口：每次在线同步补足新消息并从旧边界裁剪。Article claim
要求完整 metadata + body/segments 才算 materialized。

Cleaner 在 `usage / quota >= 0.90` 时启动，以 `<= 0.80` 为目标。Storage estimate 是
origin 级粗略值，因此同时维护 logical bytes，并设置：

- bounded batch；
- no-progress guard；
- 无候选时终止；
- `QuotaExceededError` 的一次紧急清理重试。

淘汰顺序：

1. 无 claim、过期、最久未访问的完整正文和旧 post 边界；
2. 未过期但优先级较低的 materialization；
3. 最后才淘汰用户仍要求保留的资源。

永不自动淘汰：

- 未确认 proposal；
- `domain_me*` 的 canonical/user decision 小记录；
- `globals`；
- active bundle；
- 其他尚未被 bundle lifecycle 明确退休的 bundle。

文章正文按整资源或完整 generation 淘汰。Post 只从 coverage 的旧端裁剪或整段删除，
不能逐行从中间挖洞。被迫淘汰受保护资源后保留 claim，并将 materialization 标记为
`evicted`，联网后可以重新物化。

## 11. 服务端协议要求

客户端重写同时要求服务端 DTO 规范化：

1. Post `sequence` 必填。
2. Conversation aggregate DTO 必须直接给出 `can_post/can_leave` 等服务端结论；客户端
   normalize 时拆成客观 core、actor projection 和 user state。
3. Article aggregate DTO 在客户端 normalize 时拆成 core、bookmark/progress 和 list
   membership；SQL 私有字段不得穿过 wire。
4. 所有离线可写 assignment 都提供独立 version。
5. read watermark 和 article progress 均使用明确的 `override | furthest` operation，不以
   服务端观察到的连接状态改变同一 action 的语义。
6. Blob download 支持 streaming、长度校验和 Range/resume；最好提供 immutable content
   identity/hash。
7. snapshot 或 event 最好具有 scope revision；没有 revision 的列表由 interact 串行化
   full snapshot 与 event replay。

## 12. 测试与验收

### 12.1 纯模型和属性测试

- 随机 grow/shrink/read/write/delete 后 extent 不变量恒成立；
- 任意 batch 后中断，文件仍是合法前缀；
- response/event/proposal 任意重排不会丢较新的 proposal；
- stale revision 不会复活已编辑或已删除 post；
- coverage 不会因孤立 row 被错误扩大；
- eviction 只从合法边界删除。

### 12.2 IndexedDB 集成测试

- upgrade hard boundary；
- connection lease 和 `versionchange`；
- transaction abort 不发布 change；
- staging publish 与 orphan GC；
- 多 tab shared/exclusive file lock；
- `QuotaExceededError` 恢复。

### 12.3 固定 Chrome 70

- 所有 IDB key/index 和 ArrayBuffer round-trip；
- 不使用 `IDBTransaction.commit()`、全局 `structuredClone` 等较新 API；
- fetch stream 使用 reader API，不依赖 async iterator；
- 生产 bundle 在线安装、离线启动、schema hard boundary；
- 多帐号切换后没有 actor projection 泄漏。

### 12.4 架构约束

通过 lint/import boundary 保证：

- React 不导入 `client/data` raw repositories；
- `client/data` 不导入 transport；
- RemoteManager 只由 `client/interact` 持有；
- 所有 server response/event 都经过同一 normalization/merge 入口。

## 13. 直接迁移策略

不做旧客户端兼容层。实施顺序为：

1. 建立 schema、事务、文件和 repository；
2. 调整 shared/server protocol；
3. 建立 interact、recovery 和本地优先 refresh coordinators；
4. 依次接入 session、conversation/posts、articles、user settings；
5. 接入 retention/quota；
6. 删除旧 resource/app/session 数据路径和重复 API；
7. 通过 typecheck、lint、build、model tests 与 Chrome 70 E2E。

最终实现不留双写、运行时 fallback 或旧数据格式 shim。version 4 cutover 会删除 version
3 的全部 stores；之后 Shell 安装新 bundle，application 与 Shell 都只读写本文格式。
