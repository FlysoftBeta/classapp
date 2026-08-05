# 离线存储与服务器同步

本文档描述截至 **2026-07-18 当前工作区**的实现，包括尚未提交的帖子与文章缓存对账改动。它是离线读取、选定离线写入、重连恢复和浏览器存储的维护契约。

当前能力的准确定位是：**已登录 SPA 的断网续用 + 显式内容下载 + 选定字段的离线写入**。它不是完整的离线优先复制系统，也不支持在浏览器重新启动或页面刷新后离线登录。

## 1. 能力边界

| 领域               | 离线读取                                        | 离线写入                                                  | 重连处理                               |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------- | -------------------------------------- |
| 对话列表           | 已缓存列表                                      | 静音、已读；置顶 API 可排队，但当前菜单离线时禁用         | 三方对账后刷新完整列表                 |
| 对话帖子           | 自动缓存最近 200 条，或按策略保留一周/半年      | 不支持创建、编辑、删除帖子                                | 复核可见窗口、补齐新帖、传播编辑与删除 |
| 对话草稿           | 支持                                            | 支持，包含清空草稿                                        | 按 `updatedAt` 与服务器合并            |
| 文章列表/元数据    | 仅显式保留策略的文章进入最终离线列表            | 书签、阅读位置                                            | 刷新列表覆盖区间并清理已删除文章       |
| 文本文章正文       | 已缓存分段；可显式下载全文并保留 1 天/1 周/半年 | 不修改正文                                                | 重新物化仍有效的下载策略               |
| PDF/二进制文章正文 | 不支持；渲染仍依赖 HTTP                         | 仅阅读器灰度/缩放设置可排队                               | 无正文离线物化                         |
| 用户设置           | 已缓存值                                        | `theme_mode`、`blob_reader_grayscale`、`blob_reader_zoom` | LWW 对账并接收配置事件                 |
| 其他业务           | 无通用离线能力                                  | 群组、学习、通知、文章创建/删除、阅读时长等仍需在线       | 按各在线子系统正常刷新                 |

几个容易误解的边界：

- `offline` feature gate 决定断线后是否继续显示应用以及是否显示离线下载入口；没有该能力的用户断线后当前会看到空白容器。
- Shell 可以从 IndexedDB 加载已安装的应用 bundle，但用户、令牌和应用状态不持久化。页面冷启动仍会调用 `getClientMe`、`autoLogin` 和状态探测；完全断网时会落到登录页。因此离线能力只保证**当前已登录页面**断线后的续用。
- 书签和“文章已缓存元数据”不等于正文已下载。最终离线文章列表由显式 `retained` 策略过滤。
- 帖子没有离线 outbox。发送、编辑和删除失败时不会在本地排队。
- 下载策略是本机物化偏好，不复制到服务器；其中的 `syncedAt` 表示本机下载流程已处理，不表示服务器保存了该策略。

## 2. 架构与职责

```text
React 组件 / hooks
        |
        v
client/api/* ----------------------------- 浏览器业务调用的唯一入口
        | 在线                                  | 离线 / 缓存预热
        v                                       v
Client.actions -- WebSocket --> Action     offlineRepository
        |                         |               |
        | EventBus                v               v
        |                    Actor / Policy   ResourceManager
        |                         |               |
        |                         v               v
        |                      Service       IndexedDB.resources
        |                         |           (cache / persisted)
        |                         v
        +---------------------- Data / SQLite

连接恢复：
Client.onConnectionChange(true)
  -> probeAppState
  -> syncOfflineContent
       -> flush pending mutations
       -> prime article list
       -> materialize download policies
  -> reload conversation/article snapshots
  -> bump REMOTE_RESUBSCRIBE generation
```

| 模块                                                          | 所有权                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `client/resource/ResourceManager.ts`                          | 唯一 IndexedDB 资源存储、事务完成语义、访问时间、配额检查和通用 LRU           |
| `client/resource/offlineRepository.ts`                        | 用户作用域 key、记录形状、本地仲裁、帖子/文章集合对账、保留策略和领域配额降级 |
| `client/resource/offlineSync.ts`                              | pending flush、显式下载、任务进度和重连内容物化                               |
| `client/api/*`                                                | 在线/离线路径选择、乐观本地写入、服务器 canonical 响应回写                    |
| `client/remote/Client.ts`                                     | WebSocket 连接、认证帧、Action 关联、超时、指数重连、强制离线和事件分发       |
| `client/hooks/useAppLogic.ts`                                 | 用户 scope 切换、快照预热、事件协作、周期同步和单飞重连恢复                   |
| `client/hooks/useChatPosts.ts`、`TextArticleReader.tsx`       | 双向无限滚动、缓存边界展示和恢复后的窗口复核                                  |
| `shared/sync/arbitration.ts`                                  | 客户端与服务器共享的 LWW/最远已读仲裁原语                                     |
| `server/actions/* -> domain/facade/* -> services/* -> data/*` | 输入校验、身份/权限、语义仲裁、SQLite 条件写入和 canonical 返回               |

不得为离线功能再引入第二套 IndexedDB/cache。业务数据必须继续通过 `offlineRepository -> ResourceManager`。

## 3. 在线、断线与强制离线

`Client.isConnected()` 的定义是：WebSocket transport 已打开且没有开启 `forcedOffline`。浏览器的 `navigator.onLine` 不参与业务分流。

### 3.1 WebSocket 状态

1. `connect()` 打开 `/ws`。
2. `open` 后先发送 `authenticate` 帧，再把 transport 标记为 connected。
3. Action 帧不重复携带 token；它依赖同一 WebSocket 上先到达的认证帧。
4. 断线会拒绝并清空所有 pending Action，然后按 500 ms、1 s、2 s……指数退避重连，上限 10 s。
5. `call()` 等待连接最多 10 s；已发送请求的响应超时为 30 s。

连接标记没有等待独立的认证 acknowledgement。当前依赖 WebSocket 帧顺序保证认证先于随后 Action；重连恢复额外延迟 150 ms 启动。

### 3.2 调试强制离线

调试菜单的“强制离线”会：

- 立即拒绝当前 pending Action；
- 令 `isConnected()` 返回 false，并通知连接监听器；
- 阻止新的 WebSocket Action 和所有通过 `apiFetch` 发出的 HTTP 请求；
- 忽略仍存活 socket 上收到的消息，但不主动关闭该 socket。

关闭强制离线后，如果 transport 仍打开就重新发送认证并触发普通恢复；否则重新连接。它用于验证离线路径，不是生产用户开关。

## 4. IndexedDB 存储模型

数据库名为 `classapp-runtime`，版本为 2：

- `resources`：离线业务 JSON，keyPath 为 `key`，带 `resourceClass`、`size`、`touchedAt`。
- `bundles`：Shell 首次安装、之后由 BundleManager 保存的单体客户端 bundle。
- `kv`：运行时元数据；当前保存 `classapp-active-build` 活跃构建指针。

三个 object store 共用数据库版本和浏览器 origin quota。v1 升级到 v2 时保留
`resources` 和 `bundles`，并将旧 localStorage 中的活跃构建指针迁移到 `kv`；
业务缓存淘汰不会删除 `bundles` 或 `kv`。

### 4.1 用户作用域和 key

所有离线业务 key 使用：

```text
offline:v1:<user-id-or-anonymous>:<kind>[:<id>]
```

主要记录如下：

| kind / key 后缀 | 内容 | 资源类别 |
| ----------------------------------------------- | -------------------------------- | ------------------------------------ | -------------- | --------- |
| `conversations` | 对话快照 | persisted |
| `posts:<type>:<id>` | 对话帖子数组 | auto 时 cache；显式策略时 persisted |
| `draft:<type>:<id>` | `{content, updatedAt, syncedAt}` | persisted |
| `version:conversation-config:<type>:<id>:muted  | pinned                           | read` | 对话可同步状态 | persisted |
| `version:download-policy:<type>:<id>` | 本机对话下载策略 | persisted |
| `articles` | 文章列表/元数据集合 | persisted |
| `article-meta:<articleId>` | 单篇文章元数据 | persisted |
| `article-segments:<articleId>` | 以 offset 为键的正文分段对象 | auto 时 cache；retained 时 persisted |
| `article-progress:<articleId>` | `{offset, updatedAt, synced}` | persisted |
| `version:article-config:<articleId>:bookmarked` | 书签及 false tombstone | persisted |
| `version:article-policy:<articleId>` | 本机文章保留策略 | persisted |
| `version:user-config:<key>` | 可离线用户设置 | persisted |

读取时仍兼容旧的 `conversation-policy:*` 和 `article-policy:*` key；新写入使用 versioned key。目前没有统一的 `offline:v1` schema migration/validation registry。

`setUserScope()` 由登录、自动登录、OOBE、用户变化和登出状态驱动。记录不会在登出时删除，只会切换到 `anonymous` 或另一用户的命名空间。当前 scope 是模块级可变变量，不支持多 tab 协调；跨多个 await 的复合操作也没有整体 session 快照，这是未来改造时需要优先解决的隔离风险。

### 4.2 事务和并发

- `get` 会在 readwrite 事务中更新 `touchedAt`，并等待 transaction complete。
- `put`、`remove`、`keys` 都等待事务完成；请求成功不再被误当成事务已经持久化。
- versioned value、已读位置和文章进度用进程内 `withKeyLock(storageKey)` 串行化同 key 修改。
- 草稿、帖子数组、文章列表和复合策略操作没有同等级锁；多 tab 以及并发 read-modify-write 仍可能丢更新。
- JSON 解析失败按 cache miss 返回，坏记录不会自动删除或迁移。

## 5. 配额与淘汰算法

每次 cache 或 persisted 写入后都会检查 `navigator.storage.estimate()`：

```text
if usage / quota < 0.80:
    return

projected = usage
for record in cache records ordered by touchedAt ASC:
    if projected / quota < 0.65: break
    delete(record)
    projected -= record.size

if projected / quota >= 0.65:
    handleOfflineQuotaPressure(projected - quota * 0.65)
```

通用 LRU 只直接删除 `cache`。如果仍不足，离线领域 handler 会主动撤销显式保留：

1. 文章候选按 1 天、1 周、半年分级，级别内优先处理更早到期者；删除正文 segments，并把策略改回 `auto`。
2. 对话候选按一周、半年分级，级别内较大的缓存优先；删除全部帖子缓存，并把策略改回 `auto`。
3. 处理到估算释放量达到目标为止。

因此 `persisted` 的准确含义是“不被通用 LRU 直接删除”，不是永久不可回收。显式离线内容可能因配额压力被领域 handler 降级，策略改变会作为本地 pending 在后续流程中标记已处理。

其他限制：

- `navigator.storage.persist()` 会在每次 persisted 写入后请求，但返回值不作为成功条件。
- quota usage 覆盖整个 origin，而 `projected` 只减去 ClassApp `resources` 记录的 JSON/Blob 大小，属于近似值。
- 浏览器清站点数据、用户拒绝持久存储或系统回收 origin 都可能删除内容。
- `bundles` 不在业务 LRU 候选中，但会计入 origin usage。

## 6. 内容缓存与下载算法

### 6.1 对话帖子保留

策略为：

```text
auto       -> 不按日期裁剪；每次合并后只留 created_at 最新的 200 条；cache
week       -> 只留 now - 7 天之后的帖子；无固定条数上限；persisted
half-year  -> 只留 now - 180 天之后的帖子；无固定条数上限；persisted
```

`savePosts` 的步骤：

1. 读取旧数组，以 post id 建 Map。
2. incoming 同 id 覆盖旧对象，从而传播编辑和 soft-delete tombstone。
3. 按 `created_at` 升序排序。
4. 应用当前策略的时间 cutoff。
5. `auto` 再取最后 200 条；按策略写为 cache 或 persisted。

显式下载使用 200 条一页，从最新页向 `before_id` 翻页：

```text
cutoff = now - retentionDays
beforeId = ""
while true:
    page = fetchPosts(limit=200, before_id=beforeId?)
    cache/reconcile(page)
    progress += count(page where created_at >= cutoff)
    if page.length < 200: break
    if oldest(page).created_at < cutoff: break
    beforeId = oldest(page).id
```

改回 `auto` 会立即重新合并并裁成 200 条；改成更短策略或日界线推进后，下一次读写会按当前时间再次裁剪。

### 6.2 帖子分页、删除和重连复核

服务器把 SQLite `posts.rowid` 暴露为稳定递增的 `Post.sequence`。双向分页优先传 id，同时在本地知道时附带 `before_sequence` / `after_sequence`：

```text
cursor = rowid(cursorId) ?? suppliedSequence
before -> p.rowid < cursor, DESC
after  -> p.rowid > cursor, ASC
```

这允许管理员 hard-delete 了游标帖子后继续分页；没有 sequence fallback 时，未知游标仍返回错误。

远端页进入 `reconcilePostPage` 时：

1. 取该页最小/最大 sequence。
2. incoming id 覆盖同 id 缓存。
3. 对已缓存、sequence 位于该闭区间、但不在远端页中的非删除帖子，生成 `is_deleted = 1` 本地 tombstone。
4. 统一交给 `savePosts` 合并和保留。

活动聊天首次加载“最新页”时，即使在线也优先用缓存 warm-start；有缓存就异步触发权威复核。复核是 single-flight：

- 按 8 条一批调用 `fetchPost` 检查当前窗口；存在则用服务器对象覆盖，`NOT_FOUND` 则标为删除。
- 如果本地窗口确认处于 Content End，从服务器最新页向前扫描，直到遇到 `sequence <= 本地最大 sequence` 或页不足；把所有更大 sequence 的帖子升序追加。
- 对话切换或再次断线会使旧复核结果失效，下一次恢复重新执行。

WebSocket `post.created`、`post.updated`、`post.deleted` 会直接更新当前窗口和帖子缓存。创建响应与创建事件可能乱序，UI append 以 id 保持幂等。由于 EventBus 没有持久 cursor，缓存 warm-start 后的上述权威复核是不可省略的。

### 6.3 离线帖子分页边界

本地帖子数组按时间升序保存：

- latest / before 查询返回 newest-first；hook 再转换为屏幕使用的 oldest-first。
- after 查询直接返回 oldest-first。
- 离线页不足 `LOAD_LIMIT` 时，只能证明到达“已保留缓存边界”，不能证明服务器内容真正结束。

`useChatPosts` 分别设置 `offlineBoundaryBefore` / `offlineBoundaryAfter`，`ChatMessageList` 显示“以上/以下内容未下载”。重连时清除提示，但在权威 catch-up 完成前保留 Content End 的谨慎状态，避免拿一个本地已删除的最后帖子直接作为 after cursor。

### 6.4 文章列表和删除对账

在线分页固定每页 50 条。普通页面写入使用 `reconcileArticlePage(entries, {offset, total})`：

1. 远端条目覆盖同 id 本地条目。
2. 根据 `offset`、`total`、该页最新/最旧 `created_at` 推导服务器本次权威覆盖的时间区间。
3. 旧缓存中位于覆盖区间但没有出现在远端页的文章视为已删除。
4. 删除其 `article-meta`、`article-segments` 和 `article-progress`。
5. 如果 `offset=0,total=0`，清空整个文章集合及上述附属记录。

空的非全量页不推断删除，避免因越界页误删。

重连时 `primeOfflineArticleList` 依次拉取 offset 0、50、100、150，最多保存最新 200 篇。`saveArticleList` 以这 200 篇替换普通窗口，同时保留旧列表中仍有显式 retained 策略的文章。在线 sidebar 增量只做按 id merge；最终页面快照再承担覆盖区间内的删除权威。

离线 `listArticles`、书签列表和 sidebar 都先调用 `getSavedArticleList()`，只返回策略仍为 `retained` 的文章；普通 auto 元数据即使还在 IndexedDB，也不属于稳定的离线导航集合。

### 6.5 文本文章正文

正文由服务器按 `SEGMENT_SIZE` 分段返回，存成单个：

```text
article-segments:<articleId> = {
  "<requestedOffset>": { offset, content, content_length, has_more },
  ...
}
```

读取先查精确 offset；没有精确项时，若 offset 落在某个已存 segment 的文本范围内，则返回从相对位置切片后的内容。正文被视为 immutable，因此即使在线，命中分段也直接作为权威内容使用，不做后台 revalidation。

显式下载策略是：

```text
auto
retained { days: 1 | 7 | 180, expiresAt: setTime + days }
```

下载从 offset 0 开始，优先复用本地分段，缺失时请求服务器；每次令 `offset = data.offset + data.content.length`，直到全文长度、`has_more=false` 或空内容。任务进度写入 Zustand `taskStore`，任务本身不持久化。

`expiresAt` 是从用户设置策略时开始的固定倒计时，不因重连自动续期。`getArticlePolicy` 发现过期时会改回 `auto` 并删除正文 segments；元数据、书签和阅读位置不会仅因策略到期删除。

PDF/二进制正文通过 `/api/articles/:id/render` HTTP 按页渲染，不经过 `offlineRepository`；当前下载按钮也对非文本文章禁用。因此 PDF 元数据或阅读器配置缓存不能提供 PDF 离线阅读。

### 6.6 文本文章离线边界

`TextArticleReader` 可以从任意已缓存且覆盖目标 offset 的 segment 启动，并支持向前/向后双向加载。缺少 segment 且当前离线时：

- 目标 offset 之前缺失，显示“以上内容未下载”；
- 目标 offset 之后缺失，显示“以下内容未下载”；
- 只有 `has_more=false` 或实际 offset 达到 `content_length` 才显示“全文完”。

这与聊天相同：缓存边界和内容真实边界必须分开表达。

## 7. 可同步状态的仲裁算法

### 7.1 通用时间戳 LWW

适用于独立、可替换的标量/布尔值：

- 三个候选分别是本地 canonical、本地 pending、服务器 canonical。
- 本地新写入的时间戳为 `max(Date.now(), current.updatedAt + 1)`，保证单记录在同一 SPA 中单调递增。
- 服务器 SQLite 只在 `incoming.updatedAt >= stored.updatedAt` 时更新。
- 服务器无论接受还是拒绝输入，都返回当前 canonical `{value, updatedAt}`。
- 客户端 `chooseLatestTimestamped(local, remote)` 仅在 `local.updatedAt > remote.updatedAt` 时保留本地；相等时服务器 canonical 获胜。

等价伪代码：

```text
localWrite.value = desired
localWrite.updatedAt = max(wallClockNow, previous.updatedAt + 1)
localWrite.syncedAt = null

serverWrite(incoming):
    if incoming.updatedAt >= stored.updatedAt:
        stored = incoming
    return stored

clientReconcile(local, remote):
    if local.updatedAt > remote.updatedAt:
        keep local pending/canonical
    else:
        store remote as canonical and mark synced
```

这使旧响应不能清除更新的本地 pending；相等时间戳由服务器统一决胜。它仍依赖不同设备的客户端时钟可比较，未来时钟可能长期压制其他设备。

当前使用该规则的状态：

| 状态          | 删除/false 表示               | 服务器存储                                     |
| ------------- | ----------------------------- | ---------------------------------------------- |
| 用户离线设置  | 普通字符串替换                | `user_config.updated_at_ms`                    |
| 对话静音/置顶 | false tombstone，不能直接删行 | `conversation_user_state.*_updated_at_ms`      |
| 文章书签      | false tombstone               | `article_bookmarks.bookmarked + updated_at_ms` |
| 文章阅读位置  | offset 可前进也可后退         | `article_read_progress.updated_at_ms`          |
| 对话草稿      | 空白输入表示清空              | `compose_draft_updated_at`                     |

### 7.2 草稿细节

离线保存先写本地 `{content, updatedAt, syncedAt:null}`。在线读取如果看到 pending，会先尝试 `saveConversationDraftAction`；否则读取服务器值并比较版本。

服务器会 `trim()` 草稿：全空白草稿执行带版本条件的 clear，非空草稿保存 trim 后内容。Action 返回最终 `{draft, updatedAt}`，客户端用它覆盖本地 canonical。因此服务器确认后，草稿首尾空白可能被规范化。

草稿写入当前没有 `withKeyLock`；同一会话快速并发保存仍依赖时间戳检查避免较旧版本覆盖较新版本，但本地 read-modify-write 本身不是严格串行事务。

### 7.3 对话已读：最远 sequence 获胜

已读位置是单调状态，不能用时间戳 LWW：

```text
winner = candidate with greater Post.sequence
tie    = keep current
```

客户端设置已读时从帖子缓存解析目标 sequence，并与本地 versioned read 和对话快照的 `last_read_post_sequence` 比较。已知目标没有更远时不生成新 pending；更远时立即把缓存对话的 unread count 清零。

服务器先验证目标帖子属于该群组/私聊，再用共享 `chooseFurthestRead` 比较当前与目标 rowid。更早的帖子即使 `updatedAt` 更大也不会让已读回退；更远的帖子即使时间戳更旧仍获胜。服务器返回 canonical `{postId, sequence, updatedAt}`。

旧版只存 post id 的本地记录会尝试从帖子缓存或对话快照补出 sequence；无法补出时为 0。这是兼容读取，不应扩展为新的记录形状。

### 7.4 文章阅读位置

文章 offset 允许用户主动往回读，所以使用时间戳 LWW，而不是较大 offset 获胜：

1. reader 对 offset 做范围约束并本地写为 `synced:false`。
2. Action 发送 `{articleId, offset, updatedAt}`。
3. Service 对文本 offset clamp 到 `[0, content.length]`；PDF 页码只保证非负整数。
4. SQLite 条件更新并返回 canonical `{offset, updatedAt}`。
5. 客户端只在远端版本不旧于当前本地版本时标记 synced。

阅读时长、active article 心跳不是离线 pending；断线时 `useArticleReading` 停止上报。

## 8. 重连同步状态机

连接恢复监听器在 connected 后 150 ms 调度，并以 `remoteRecoveryRunRef` 保证 single-flight：

```text
1. probeAppState()
   -> 更新 session、feature gate、锁定/禁用等全局状态

2. syncOfflineContent()
   2.1 syncPendingMutations()
       -> 并行启动 user settings / conversation config / article config
       -> 枚举 pending drafts，逐会话触发 fetch-and-flush
       -> 枚举 pending article progress，逐文章 save
   2.2 primeOfflineArticleList()
       -> 最多刷新最新 200 篇
   2.3 conversation policies
       -> 逐策略下载；单条失败隔离；成功标记本机 processed
   2.4 article policies
       -> 逐策略下载；单条失败隔离；成功标记本机 processed

3. Promise.all(
     loadConversations(),
     loadArticleSidebar(),
     loadArticleList(currentOffset)
   )

4. dispatch(REMOTE_RESUBSCRIBE)
   -> 重建依赖 remoteGeneration 的 React 事件协作
```

`syncPendingMutations` 内部大量使用 `Promise.allSettled` 和逐记录 `try/catch`，一条坏记录不会阻塞其他记录。所有策略（包括已经处理过的）仍会在每次恢复时枚举；conversation 的 `auto` 立即返回，article 的 `auto` 不下载，但仍会更新 processed 标记。

应用处于已登录 `app` 状态时，每 120 秒还会执行一次 `probeAppState` 和 `syncPendingMutations`。周期心跳不重新下载内容策略，完整物化只在恢复或用户手动保存策略时执行。

30 秒 Action timeout 是歧义结果：服务器可能已经提交而客户端没有收到响应。所有允许离线的服务器写入都由 timestamp 或 sequence 保持幂等，因此可安全重试。

## 9. EventBus、列表和阅读器的协作

EventBus 没有 durable event id/cursor，也没有“已重放至某点”的证明。各子系统采用以下协作方式：

| 事件/场景                      | 处理方式                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| `conv.updated`                 | debounce 后重新拉取完整对话列表；快照与 pending pin/mute/read 三方对账   |
| `post.created/updated/deleted` | 当前聊天窗口和帖子缓存直接按 id 更新；重连后再做权威窗口复核             |
| `article.sidebar_updated`      | 调度 sidebar 全量刷新                                                    |
| `article.list_updated`         | bump revision 并重新加载当前文章页                                       |
| `user.config_changed`          | 用 event 的 `{value,updatedAt}` 与本地 pending 仲裁；主题等可立即更新 UI |
| 在线进入已有聊天               | 先用缓存渲染，再异步 revalidate                                          |
| 在线进入已有文章               | 先用缓存 meta 渲染，再拉服务器 meta；正文 segment 命中即直接使用         |
| 重新上线                       | 先 flush，再刷新权威快照，最后依赖新事件增量                             |

Infini 双向滚动只负责窗口、游标、保持锚点和加载状态；“数据来自缓存还是服务器”“缓存边界是否是真实 EOF”由 API/hook 明确传入。具体规则另见 `INFINI.md`。

## 10. 与应用更新、身份和 UI 子系统的协作

### 10.1 Shell / BundleManager / Service Worker

- 生产 `shell.html` 先从 `kv` 读取 `classapp-active-build`，再从 `bundles` 读取对应构建；网络失败但已有 bundle 时仍可启动前端代码。
- 整个发布只有一个 build id；manifest 同时描述该构建的 Shell 和 bundle。
- 首次安装之后，`BundleManager` 独占 manifest 检查、两个资产的下载、大小校验、暂存和激活；API/WebSocket build mismatch 只触发 manager，不直接 reload。提交任一侧失败时会尝试把 bundle 与 Shell 指针一起恢复到之前的 build id。
- Service Worker 不独立检查更新。它缓存 manager 推送的 Shell，并在 Cache Storage 中保存活跃 Shell build id；导航只读取该活跃 Shell。Service Worker 首次安装时自行下载 Shell 是唯一例外。
- 调试“强制离线”只拦截 Client Action 和 `apiFetch`；BundleManager 使用原生 `fetch`，其五分钟定时更新检查不受该开关约束。该开关不是浏览器级网络沙箱。
- bundle 激活与 `resources` 共享数据库版本但不是同一 object store；离线 schema 变更不能只修改其中一个 open/upgrade 入口。
- bundle 可启动不等于业务会话可恢复；当前身份状态不持久化，冷启动离线仍无法进入已登录应用。

### 10.2 身份与权限

- scope 必须在登录用户确定后切换，随后才读写该用户缓存。
- 服务器重放仍经过 `Action -> Actor/Policy -> Service -> Data`；离线排队不绕过群成员、文章访问和 feature gate 检查。
- 用户被删除、离群或失去访问权限后，pending 可能永久失败；当前没有 terminal quarantine，会在每次周期/重连继续尝试。

### 10.3 UI 和任务

- 全局 `online=false` 显示“离线”状态条。
- 聊天/文章阅读器分别显示上下未下载边界。
- 对话和文章下载把 running/completed/failed/progress 写到内存 `taskStore`；刷新后任务历史消失。
- 下载策略可在离线时先保存，重连再物化。已有内容仍可读，但新策略在下载完成前不保证内容完整。
- 当前对话“置顶”菜单离线禁用，尽管底层 API 已支持 pending；静音菜单允许离线。维护文档应区分底层能力与当前 UI 暴露。

## 11. 失败语义与已知风险

### P1：正确性/产品边界

1. **不支持离线冷启动身份恢复。** Shell 能启动 bundle，但用户/token/app state 不持久化。
2. **客户端时钟受信任。** 未来时间戳可能长期压制另一设备；应迁移到服务器逻辑 revision，并加入设备 tie-breaker。
3. **EventBus 无 durable cursor。** 当前靠重连快照和聊天窗口复核缩小缺口，不能证明事件无遗漏。
4. **永久失败不隔离。** 已删除或无权目标的 pending 会持续重试，用户看不到 terminal failure。
5. **多 tab 不安全。** 用户 scope、key lock 和 read-modify-write 都是单 SPA 设计；需要 Web Locks/BroadcastChannel 或单 tab lease。

### P2：存储与维护性

1. `offline:v1` 没有 typed migration/validation registry；坏 JSON 静默 miss。
2. 文章所有 segments 聚合在一个 JSON record，每次新增分段都会读写整个对象，大文章存在写放大和并发覆盖风险。
3. 明确保留内容没有用户可见的占用统计/批量清理；配额 handler 降级策略时也没有专门提示。
4. scope 是模块级变量；复合异步操作没有绑定不可变 repository session。
5. policy 的 processed 标记不参与恢复筛选，所有策略每次重连都重新枚举。
6. 多处 fire-and-forget/cache 错误被吞掉，无法区分断线、quota、权限、坏记录和冲突。
7. IndexedDB、强制离线、重连、多 tab 和配额降级缺少浏览器集成测试。
8. 文章页面删除推断依赖 `created_at` 覆盖区间；相同时间戳边界需要持续用集成测试验证。

## 12. 未来修改必须保持的 invariant

1. 每条业务 key 必须包含用户 scope；新代码应在异步操作开始时捕获不可变 scope/session。
2. pending 只能被同版本或更新的服务器 canonical 响应清除；旧响应不得擦除新写入。
3. 每个 conflict-aware write 必须返回服务器 canonical 值和版本。
4. LWW 只用于独立 replaceable state；已读、计数器、集合、操作序列和协作文档必须定义语义仲裁。
5. 已读永不回退，只比较服务器稳定 sequence。
6. reconnect 是 invalidation boundary：先 flush，再刷新权威快照，之后才依赖增量事件。
7. 单记录失败不得阻塞无关记录。
8. snapshot replace/reconcile 与 incremental merge API 必须分开命名；调用方必须明确 absence 是否表示删除。
9. 缓存边界不得伪装成 Content Start/End；UI 必须能显示“未下载”。
10. cache/persisted 分类变化必须立即重写资源类别并执行相应裁剪。
11. IndexedDB 版本升级必须同时兼容 Shell、BundleManager 和 ResourceManager；Shell/bundle 激活始终使用同一个发布 build id。
12. 新的服务器同步写入继续遵守 `API -> Action -> Actor/Policy -> Service -> Data`；SQL 只放在 Data，业务仲裁放在 Service/shared helper。

## 13. 测试与变更清单

现有自动检查：

- `npm run test:offline-sync`：共享仲裁、服务器条件写入、schema v15 迁移。
- `npm run test:protocol`：Action/wire 合约，包括 hard-delete cursor 的 sequence fallback。
- `npm run test:infini2`：双向加载、失败和窗口状态机。
- `npm run lint`：TypeScript 与 ESLint。

修改离线域时至少覆盖：

- older/newer/equal timestamp 和服务器 tie winner；
- 更远/更早 read sequence；
- 同 key 快速连续保存与乱序响应；
- timeout-after-commit 后的安全重试；
- 断线时缓存边界、重连时 window revalidation；
- soft delete、hard delete、游标本体已删除和覆盖区间 absence；
- 文章列表首/中/末页删除以及全空快照；
- 策略到期、80%/65% quota 降级、浏览器拒绝 persistent storage；
- 用户切换、登出、多个 tab 和中途 scope 变化；
- 坏 JSON、旧 key、schema migration 和站点数据被清理；
- Shell 有 bundle/无 bundle 两种离线冷启动结果。

推荐的硬化顺序：

1. 持久化最小且可撤销的离线身份/session envelope，明确冷启动安全模型。
2. 用服务器逻辑 revision + device tie-breaker 替换客户端墙钟。
3. 增加 terminal/retryable 错误分类、quarantine 和同步状态 UI。
4. 引入 `offline:v2` typed validation/migration，并拆分文章 segment 记录。
5. 用显式 repository session 固定 user scope，再增加多 tab 锁。
6. 增加真实浏览器的 IndexedDB、重连、配额和乱序网络集成测试。
