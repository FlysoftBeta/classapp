# 文章列表：排序与 Cursor 分页

文章中心有三个有序视图：全部文章、收藏文章和最近阅读。它们共用
`listArticlesAction` 的 cursor 分页协议，但每个视图有自己的排序值。

## 为什么不用 OFFSET

`OFFSET n` 需要 SQLite 找到并丢弃前 n 条记录。页数越深，工作量越大；
同时插入或更新文章会让页边界移动，造成重复或漏项。

文章列表使用 keyset pagination。一个 cursor 始终是：

```ts
{
  sortAt: string;
  id: string;
}
```

`sortAt` 是该视图的主要排序值，`id` 是稳定的次级排序键。仅使用文章
ID 不足以分页：ID 不表示文章在创建时间、阅读时间或收藏时间中的位置。
次级 ID 也不能省略，因为多个记录可以具有相同的 SQLite 时间戳。

## 视图及其稳定顺序

所有顺序均为降序，即最新记录在前。

| view         | 主排序值 `sortAt`                                          | SQL 顺序                   |
| ------------ | ---------------------------------------------------------- | -------------------------- |
| `all`        | `articles.created_at`                                      | `created_at DESC, id DESC` |
| `bookmarked` | `COALESCE(read_progress.updated_at, bookmarks.created_at)` | `sortAt DESC, id DESC`     |
| `recent`     | `read_progress.updated_at`                                 | `sortAt DESC, id DESC`     |

`recent` 只包含达到 `READING_HISTORY_MIN_SECONDS` 阈值的文章。收藏文章
的“最近”语义优先使用最近阅读时间；未阅读的收藏则按收藏时间排序。

每个列表响应的文章都带有 `list_sort_at`。它是服务器计算出的不透明排序
值，客户端应将其与文章 ID 原样组成下一次请求的 cursor，而不要重新推导。

## Action 协议

```ts
listArticlesAction({
  view: "all" | "bookmarked" | "recent",
  cursor?: { sortAt: string; id: string },
  direction?: "before" | "after",
  group_id?: string,
})
// => { articles, hasMore }
```

- 不带 cursor 表示从该视图最前端开始。
- `after` 表示在标准降序内容中继续向后，即取得更旧的记录。
- `before` 表示取得更靠前、更新的记录。
- 返回最多 50 条；服务器内部取 51 条，以 `hasMore` 表示当前方向是否仍有
  数据。
- `before` 在 SQL 中使用升序查询以便高效取最近的 50 条，再在返回前反转，
  因此客户端始终收到标准降序的连续条目。

对于降序 `(sortAt, id)`：

```sql
-- after：更旧
WHERE sortAt < :sortAt
   OR (sortAt = :sortAt AND id < :id)

-- before：更新
WHERE sortAt > :sortAt
   OR (sortAt = :sortAt AND id > :id)
```

不要在新的调用点重新引入 `offset` 或 `total`。精确总数意味着额外的
`COUNT(*)` 扫描；无限滚动只需要 `hasMore`。

## 数据访问与索引

列表读取 bookmark 和 progress 时使用 `LEFT JOIN`，而不是为每篇文章执行
多个相关子查询。收藏视图从 `article_bookmarks` 过滤后关联文章；这样不会先
扫描所有文章再判断是否收藏。

相关索引在数据库初始化时以幂等方式创建：

```sql
CREATE INDEX idx_articles_created_id_group
  ON articles(created_at DESC, id DESC, group_id);

CREATE INDEX idx_article_bookmarks_user_state_created
  ON article_bookmarks(user_id, bookmarked, created_at DESC, article_id DESC);
```

阅读进度和收藏项的主键 `(user_id, article_id)` 支持按文章读取元数据。收藏
和最近阅读按表达式排序，可能仍需要对已过滤的候选集排序；这比对全部文章
执行相关子查询和排序要小得多。

## 客户端与 Infini

`ArticleList` 的每个文章行保存由 `list_sort_at` 构成的 `ArticleListCursor`。
普通相邻滚动直接将边界行 cursor 传给 `listArticles`，分别请求 `before` 或
`after`，不执行 SQL offset 分页。

Infini 的 `locateOffset` 是对可视区域跳转的估算接口，不是服务端分页契约。
在无法直接定位到任意文章的情况下，客户端将该估算转换为 cursor 的连续取页。
这牺牲了远距离跳转的常数时间，但保持了正确、稳定的 keyset 分页；若未来需要
真正的随机跳转，应增加按视图查找锚点的独立 action，而不是恢复 OFFSET。

## 变更规则

新增文章视图时必须同时定义：

1. 主排序值及其稳定 ID 次级排序；
2. cursor 的 `before` 与 `after` 比较条件；
3. 每条结果的 `list_sort_at`；
4. 对应的过滤/排序索引或其查询计划依据；
5. 该视图在离线缓存和 Infini provider 中的边界语义。
