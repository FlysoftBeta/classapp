进行以下修改：
服务端错误处理范式：

1. 使用类似 Rust 的 panic 语义，panic 即为“无法继续处理的错误”。panic 在 ts 中的传递方式即为 throw/try/catch/finally。现有代码需要正确处理 finally 错误。避免滥用 catch，而导致原始错误信息被吞没。
2. 去除陈旧的 ServiceError（基于HTTP code的错误，这种语义混合了）。去除 token 无效错误，因为现在都是WS长连接，应该在会话初始时用 token 鉴权。
   客户端错误处理：
3. 远程调用处理：一般情况，Remote manager会进行多次重试；重试失败后，将会 reject promise。此时客户端需要避免损毁客户端数据库（执行好 finally）
4. 其他的错误，还是与服务端那里一样的理念，无法处理，就别 catch。finally执行好清理逻辑即可。这方面需要你排查一下。
   错误上报：
5. ID 单调增；把 ID 进行 AES 加密，避免透露 head ID 所在位置。最好呈现出来的 Incident ID 是一个短字符串。
6. 错误归类：将 call stack、build id、environment 相同的归为一类，其中 call stack 指最后出错的位置（我们不用 message 做判据，因为可能有所不同），build id 可以在后台dashboard呈现时筛选，environment 则说明是 server/client。一个错误至多存储10条，之后的错误仍有Incident ID，只不过 SQLite 里用 NULL 存储那些信息。
7. 管理员面板：管理员后台应有一个incident 查看 panel。并提供一个手动触发 incident 的测试按钮。

客户端数据存储infra重新整理：

1. 当前，很多 schema 的代码都放在 shell.html 中。这会导致维护混乱。我的想法是，把 classapp-runtime 这个 IDB 拆成两部分，一个是 shell-schema，一个是 app-schema，不去用 db version 了（pin db version to 6）。
2. 其中，shell 只负责 shell_bundles，shell_kv 的操作与升级。shell-kv 存储 active bundle 与 schema version。shell 的职责则更新为：安装 service worker（如果能的话），创建或更新上面两个表，初始化 bundle 下载，加载 bundle。
3. app 则负责 globals，domain，files等表的维护，schema version也是自己独立的，升级逻辑在 migration.ts 里
4. 需要注意的是，migration 需要增加一个逻辑，判定当前 schema 是否属于 yanked 版本。如果属于，会执行 nuke 操作，原子移除所有 app 对应的 tables。现有的所有 db 都是 yanked 的。

此外，

1. 避免使用全局状态。数据库中的全局状态，仅供初始化时使用。例如，实际过程中，滥用 activeMe 会导致一个完整过程中状态撕裂。应善用 Context（Context不必包含db，remote manager，update manager等等，这类没必要）。与 WS 配合，则是让与用户上下文有关的消息带上 user 字段。RemoteManager 实践上应该允许一个transport里带多个user。
2. 避免在客户端数据库内使用 handle 作为标识，使用 id。因为 handle 可以改。目前这会导致不少 correctness 问题。
3. Article 的 immutable invariant 被打破。用户一旦改名，Immutable article changed 就会报错。只应该用 id 标识，具体的 entity 保存在 domain_users 里。只有这样，才能符合文章不变的 invariant。既然符合这个invariant，就没必要拉取现有的了。
4. Posts 缓存的处理逻辑：当前是 revision driven的，我的新想法是，revision 的 sum 只要变化了，一定是发生了变化。如果 revision 不变，就没必要了
5. 上面 Articles 与 Posts 的逻辑可以统一规范一下（**Coverage 机制**）。这都是处理无限滚动列表的实践。这种实践就是：1) 列表连续（非离散片段）；2）不存在中间插入与删除（时序数据不能篡改）；3）可选处理修改：通过区间 revision和 降低传输 overhead；4）其他具体的，参考 **Post coverage**
6. 还存在一些其他 Robustness 问题，也请一并修复 /home/flysoft/projects/classapp-next/docs/audit-log.md。

要求

- 尽量不要参考现有的实现，他们都是 poorly implemented 的。我正是希望你能推翻这些糟糕的设计与代码。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见，思考最佳的设计模式。
- 改动不限制 scope。
- 请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。

先评估这套方案。
