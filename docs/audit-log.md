我把客户端 IDB 这一层完整追了一遍。结论是：**现在确实存在多处能制造“逻辑数据库损坏”的路径**，而且其中几处非常符合“网络正常，但对话/文章列表/文章突然打不开，清 IndexedDB 后恢复”的症状。

这里很多并不是 Chromium/LevelDB 意义上的物理 corruption，而是：

> **IDB 结构本身完好，但缓存中的实体、access、coverage、retention 等互相矛盾；随后业务层又把 IDB 放在 online 请求的 critical path 上，于是一个缓存异常把远端正常数据也一起堵死。**

我认为有 5 个 P0。

### 1. `domain_users/groups.by-handle UNIQUE` 会被陈旧实体永久 poison

`client/data/schema.ts:34-65`：

```ts
groups.createIndex("by-handle", "handle", { unique: true });
users.createIndex("by-handle", "handle", { unique: true });
```

但 `saveConversations()` 只替换当前用户的 `ME_ACCESS` snapshot：

`client/data/repository.ts:902-930`

```ts
for (const key of oldKeys) accessStore.delete(key);

for (const entry of entries) {
  await upsertConversationInTransaction(tx, meId, entry);
}
```

**没有 GC 已经失去 access 的 `GROUPS` / `USERS` objective rows。**

而服务器允许：

- user 改 handle：`server/data/users.ts:192`
- user 删除/revoke 后释放原 handle
- group 删除：`server/data/groups.ts:332`
- group 本身也允许字段更新

于是完全可以发生：

```text
本地:
users["user-old"].handle = "foo"

服务器:
删除/改名 user-old
创建 user-new，handle = "foo"

下一次客户端同步:
USERS.put({ id: "user-new", handle: "foo" })

=> unique index ConstraintError
=> 整个 saveConversations transaction abort
```

这类错误**会永久存在**，因为失败的 refresh 根本没机会修正旧 row。

清 IDB 后恢复则完全符合这个模型。

#### 修法

客户端缓存里根本不应该用 mutable display identifier 维护 unique constraint。

直接改成：

```ts
users.createIndex("by-handle", "handle"); // non-unique
groups.createIndex("by-handle", "handle"); // non-unique
```

真正 identity 已经是 `id`。

如果确实要唯一性，也应该把 objective GC 和 snapshot reconciliation 做正确，但我还是建议缓存层不要复制 server uniqueness invariant。

---

### 2. Article 的 “immutable” 检查实际上比较了 mutable metadata

`client/data/repository.ts:609-668`：

```ts
const previous = await articleStore.get(entry.id);

if (previous && !Values.equal(previous.value, entity.value)) {
  throw new Error(`Immutable article changed: ${entry.id}`);
}
```

问题在 `splitArticle()`。

它只剥掉：

```ts
is_bookmarked
bookmark_updated_at_ms
current_offset
current_offset_updated_at
...
```

然后把剩下的全部塞进 `entity.value`。

而 `ArticleWithMeta` 里面还有：

```ts
title
username
handle
...
```

尤其：

```ts
username: z.string().nullable().optional(),
handle: z.string().nullable().optional(),
```

作者改一次用户名：

```text
article A:
username = "Alice"

用户改名

同一个 article A:
username = "Alice2"
```

就会：

```text
Immutable article changed: A
```

这还不是单篇失败。

`client/interact/articles.ts:80-91`：

```ts
return Promise.all(
  articles.map((article) => reconcileArticleProgressMeta(article, membership)),
);
```

**一篇文章 metadata 有变化，整个 article page/list reconcile 全部 reject。**

所以“文章列表突然完全打不开”非常容易由这一处造成。

更严重的是 `fetchArticle()`：

```ts
const result = await fetchArticleAction(articleId);

if (data.article) {
  data.article = await reconcileArticleProgressMeta(data.article);
}
return data;
```

远端已经成功返回文章了，**但 IDB reconcile 报错后，远端成功结果也被丢掉。**

这就是缓存 corruption 升级成 online outage 的关键原因之一。

#### 修法

正文 immutable ≠ article object immutable。

应该只 immutable-check 真正决定正文 identity 的字段，例如：

```text
article_id
content_kind
provider / archive identity
正文版本/hash
```

`username`、`handle`、甚至 `title` 等 metadata 应正常 update。

---

### 3. Posts eviction/trim 存在真实 TOCTOU，会把 coverage 写坏

这是我认为最危险的一处真正逻辑 corruption。

`deleteConversationPostPrefix()`：

`client/data/repository.ts:251-288`

先传进一份旧快照：

```ts
orderedRows: StoredPost[]
```

然后分批删：

```ts
const batch = orderedRows.slice(start, end);
const retained = orderedRows.slice(end);
```

每一批 transaction 里面却重新读取**当前 coverage**：

```ts
const coverage = await syncStore.get(scope);
```

随后使用**旧 posts snapshot** 覆盖它：

```ts
syncStore.put({
    ...coverage,
    lower: first ? ... : null,
    upper: last ? ... : null,
    reached_oldest: false,
});
```

因此：

```text
T0 cleanup snapshot:
posts = [1 ... 100]
upper = 100

T1 websocket/live sync:
写入 post 101
coverage.upper = 101

T2 cleanup:
使用 T0 retained[]
重新写 coverage.upper = 100

=> coverage 倒退
```

更极端的是 `clearConversationPostWindow()`：

```ts
rows = read all posts
await deleteConversationPostPrefix(...)

await transaction(SYNC, () => {
    delete(`posts:${convId}`)
})
```

中间如果有新 post 保存成功：

```text
新 posts 实际存在
SYNC coverage 却被最后一步删掉
```

这已经是典型 TOCTOU。

---

### 4. 所有 posts 被 trim 后，conversation 会进入“吞消息但 revision 继续前进”的坏状态

这个 bug 比上面的竞态还确定，**单线程顺序执行都能触发**。

全部 posts 被删除后，`deleteConversationPostPrefix()` 会留下：

```ts
{
    lower: null,
    upper: null,
    reached_oldest: false,
    reached_newest: 原值
}
```

假设原先：

```text
reached_newest = true
upper = post 100
```

trim 掉全部后：

```text
reached_newest = true
upper = null
```

随后 live post 101 到来。

`applyPostVersion()`：

```ts
const mayExtendNewest =
  liveAppend &&
  !!coverage?.reached_newest &&
  !!coverage.upper &&
  post.sequence > coverage.upper.sequence;
```

由于：

```ts
coverage.upper === null;
```

所以：

```ts
mayExtendNewest = false;
```

进 `savePosts(... extendCoverage: false)`。

然后：

```ts
const insidePublishedWindow =
    !!current?.lower &&
    !!current.upper &&
    ...

if (
    options.extendCoverage !== true &&
    !previous &&
    !insidePublishedWindow
) {
    continue;
}
```

也就是说：

> **新 post 被静默丢掉。**

revision sync 更糟：

`reconcilePostRevisions()`：

```ts
await this.savePosts(ref, incoming, { extendCoverage: false });

if (coverage?.reached_newest && coverage.upper) {
   ...
}

await this.advancePostRevision(convId, revision);
```

此时：

- incoming posts 没写进去；
- `upper === null`，append repair 不运行；
- 最后却把 `known_revision` 前进了。

于是状态变成：

```text
数据库没有 revision N 的 posts
known_revision = N
```

之后同步还以为这些 revision 已经处理。

**这是真正的数据一致性破坏。**

普通 retention 就能触发，不需要异常环境：

```text
conversation 所有缓存消息过期
→ trim 全删
→ coverage 进入 empty-invalid state
→ 后续 live/revision 被吞
```

#### 修法

最简单的 invariant：

> **0 posts ⇒ 不允许存在 published coverage。**

删到 0 时直接：

```ts
syncStore.delete(`posts:${convId}`);
```

而不是：

```ts
lower = null;
upper = null;
reached_newest = true;
```

并且 `known_revision` **只能在确认所有 relevant revisions 已经落库/明确无需落库之后更新。**

---

### 5. IDB 被放在 online 数据的 critical path 上

这是为何一个小缓存错误能表现成“整个 App 功能坏掉”。

#### Conversations

`client/interact/conversations.ts:53-60`

```ts
const result = await fetchConversationsAction();

await offlineRepository.saveConversations(result.data);

return sortConversations(await offlineRepository.getConversations());
```

服务器已经成功返回，但：

```text
saveConversations ConstraintError
```

就会走：

```ts
catch {
    return offlineRepository.getConversations();
}
```

如果 IDB 本身现在也处于逻辑异常：

```text
remote SUCCESS
        ↓
cache write FAIL
        ↓
cache read FAIL/stale
        ↓
UI blank
```

#### Articles

`loadArticleForReader()` 更明显：

```ts
const cached = await fetchCachedArticle(articleId);

if (!client.isConnected()) ...
const remote = await fetchArticle(articleId);
```

**先读 IDB，后请求远端。**

只要 cached read throw：

```text
根本不会 fetch remote
```

而 `fetchArticle()` 内又要求：

```ts
remote success
→ IDB reconcile success
→ 才返回 remote
```

形成双重 dependency。

`fetchArticleSegment()` 反而已经采用正确模式：

```ts
try {
    await offlineRepository.saveArticleSegment(...)
} catch {
    // remote payload is still usable
}
```

**article metadata/list/conversation 应该采用完全一样的原则。**

---

## 另外几处确定的 TOCTOU

### `activeMe()` 是 global mutable implicit context

```ts
let userScope = "anonymous";

function activeMe() {
  return userScope;
}
```

很多 async operation 没有在入口 capture actor。

最明显：

```ts
async saveArticleList(entries) {
    for (const entry of entries) {
        await upsertArticle(activeMe(), entry, ...)
    }
}
```

如果处理几十篇文章期间 session scope 改变：

```text
article 1..20 → A
切换身份
article 21..40 → B
```

同一个逻辑 batch 被拆进两个 namespace。

`reconcileArticlePage()` 更离谱一点：

```ts
const scope =
  `me:${activeMe()}:articles:${...}`;

const current = await store.get(scope);

// async boundary

store.put({
    scope,
    me_id: activeMe(),
});
```

理论上能得到：

```text
scope = me:A:articles:...
me_id = B
```

这是直接违反 row invariant。

不过有一点需要修正我前面的判断：`remote/client.ts` 对 Action 做了：

```ts
authEpoch: session.getEpoch();
```

而 token change 会：

```ts
cancelPending("登录身份已切换");
```

返回 response 时又校验 epoch。

所以**旧 Action response 横跨登录直接污染新用户**这一条已经大部分被防住了。

但是：

- 已经进入 local reconcile 的长任务
- quota/retention 后台任务
- repository 多 await operation
- `event` frame

都没有同样的 actor generation protection。

正确设计应该是 operation 开头：

```ts
const ctx = {
  meId: activeMe(),
  authEpoch: session.getEpoch(),
};
```

之后所有 helper 显式传 `ctx`，整个 operation **绝不再读 `activeMe()`**。

---

## `purgeArticle()` 是经典 multi-transaction delete race

`repository.ts:1744-1787`：

```text
TX1: snapshot segments/access/state/save keys

TX2: delete ARTICLES

TX3..N: batch delete segments
TX...: batch delete access
TX...: batch delete state
TX...: batch delete save
```

例如：

```text
purge snapshot
↓
delete ARTICLES
↓
remote reconcile 正好 upsert article + access
↓
purge 根据旧 snapshot 删除 access
```

最终：

```text
ARTICLES[id] 存在
ME_ACCESS[id] 不存在
```

即：

> objective entity 活着，但用户无法 materialize 它。

反过来 concurrent segment save 也能产生 orphan segment。

这里需要至少一个 **article generation/tombstone**，不能靠“先 snapshot 再慢慢删”。

---

## retention policy 也有 check-then-act race

`getArticlePolicy()`：

```ts
const row = await read();

if (policy.expiresAt <= Date.now()) {
  await this.setArticlePolicy(articleId, { mode: "auto" });
}
```

可能发生：

```text
T1 getArticlePolicy 读到 expired

T2 用户重新设 retained 180 days

T1 stale continuation:
setArticlePolicy(auto)

=> 新政策被旧读取覆盖
```

典型 TOCTOU。

这里应该在一个 readwrite transaction 里：

```text
read current
if current.version / protectedUntil 仍然是刚才那个 expired value
    update
```

或者 retention row 加 generation/version。

---

## offline article 有“没下载完却 materialized=true”

`client/interact/sync.ts:137-160`：

```ts
while (offset < end) {
    ...
    if (!data?.content) break;

    offset = ...
    ...

    if (!data.has_more) break;
}

await offlineRepository.markArticlePolicySynced(articleId);
```

无论是：

```text
content 突然 null
```

还是服务器异常提前：

```text
has_more = false
offset < contentLength
```

都会：

```text
materialized = true
```

也就是说数据库声称：

```text
offline complete
```

实际正文 segment 缺失。

这里最后必须至少：

```ts
if (offset < contentLength) throw new IncompleteDownloadError();
```

最好重新验证所有 segment coverage。

---

## `runTransaction()` 本身有一个 lease lifecycle race

`client/data/idb.ts:162`：

```ts
const lease = await runtimeDatabase.acquire();
const tx = lease.db.transaction(names, mode);

try {
   ...
} finally {
    lease.release();
}
```

如果：

```ts
lease.db.transaction(...)
```

同步 throw，比如刚好遇上：

```text
versionchange
pagehide
connection close
```

程序甚至还没有进入 `try`。

于是：

```text
lease.release() 永远不会执行
```

`leases` 永久 +1，自动 close 会一直被 suppress。

应该改成：

```ts
const lease = await runtimeDatabase.acquire();

try {
    const tx = lease.db.transaction(names, mode);
    ...
} finally {
    lease.release();
}
```

这个更偏 connection lifecycle bug，不会直接制造脏 row，但会让 IDB 状态越来越诡异。

---

## Article list 还有“幽灵 membership”

`upsertArticle()` 对 membership 的操作是：

```ts
const memberships = old.filter(not same view/group);
memberships.push(currentMembership);
```

但 article page reconcile 只负责**添加/更新**。

没有完整 snapshot reconciliation 去表达：

> “服务器当前这个 list 中已经没有 article X，因此移除 X 对这个 view 的 membership。”

而 `getArticleList()` 最后主要依据当前用户的 article access rows materialize。

因此服务器删除/移走文章后，本地可能长期留下 phantom article，直到收到明确 purge 或清 DB。

它本身不一定造成打不开，但会逐渐提高 objective/access 不一致的概率。

---

# 我认为最可能对应当前线上症状的故障链

如果用户反馈是：

> 原本好好的 → 某天一个客户端突然对话/文章列表/文章都打不开 → 清网站数据恢复

最优先怀疑这条：

```text
stale objective user/group
        ↓
handle 被服务器重新使用
        ↓
IDB unique index ConstraintError
        ↓
saveConversations / upsertArticle transaction abort
        ↓
article/conversation online path 要求 cache write 成功
        ↓
上层 catch 吞掉具体 DOMException
        ↓
UI 表现为“加载失败 / 空白 / 打不开”
        ↓
清 IDB
        ↓
stale unique row 消失
        ↓
恢复
```

以及 article 独有的：

```text
作者改 username / handle
↓
ObjectiveArticle.value 改变
↓
"Immutable article changed"
↓
Promise.all 整个 article list reject
↓
文章列表打不开
```

这两个我会首先在线上加日志验证。

---

# 修复优先级

我建议不要零敲碎打，按下面顺序直接收掉：

1. **删除 cached handle 的 unique index**；identity 只认 immutable ID。
2. **Article immutable check 缩小到真正 immutable body identity**，metadata 允许更新。
3. **remote success 不得依赖 cache success**。IDB 是 projection/cache，不是 online 请求提交的一部分。
4. **重写 posts eviction/coverage**：删除和 coverage 更新必须基于 transaction 内真实 current rows；empty window 直接删除 coverage；禁止 dropped revisions 后仍 advance revision。
5. **消灭异步逻辑中的裸 `activeMe()`**：operation 起点 capture `ActorContext`，后续全部显式传。
6. **purge 引入 generation/tombstone**，禁止 snapshot-delete 和 concurrent upsert 互相穿透。
7. retention/quota 使用 CAS/generation，并在真正删除前重新检查 protection。
8. offline article 只有完整验证后才能 `materialized=true`。
9. 修 `runTransaction()` lease leak。
10. 加启动时 **IDB invariant checker + scoped self-heal**，而不是等用户手动清库。

最重要的是第 3 点。即使前面所有 consistency bug 都没找干净，也应该保证：

```text
服务器返回了有效 conversation/article
       ↓
cache 爆炸
       ↓
记录 cache error + 尝试 repair
       ↓
仍然把 remote payload 给 UI
```

这样 IDB 最坏只是“离线缓存坏了”，而不会再升级成“ClassApp 在线都打不开”。

这次静态追踪已经足以确认**至少存在两个确定可复现的 permanent poison（unique handle / article immutable metadata），一个确定可复现的 posts 状态机 corruption，以及多处真实 TOCTOU**；并不是单纯怀疑 Chromium IDB 不稳定。
