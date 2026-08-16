用 streamdown + openai sdk 搭一个对话系统。
UI/UX：

1. 在 Sidebar 增加 Bottom Navigation，分成 对话，AI，阅读 三个部分。避免需要侧栏分板块。切换侧栏后不影响右边 Main content，需要点击对应的对话/小说才会触发 Navigation。移动 UI 则遵循另一套你熟悉的那套逻辑。
2. 侧栏显示对话 title，如果有新回复会显示蓝点。
3. 同样地，也有 MessageBanner 功能。

功能：

1. 快速检索对话：标题生成 + 标签生成，其中标签覆盖尽可能广一些（需要提示词工程）。允许多字的短语。搜索时也会触发 LLM 生成标签（SQLite 优先匹配 标题原文本，再匹配标签，标签是exact match）。（需要提示词工程）
2. 上下文管理：支持聊天树功能（点一下 fork），就不要支持编辑消息功能了（那样需要再做一套 UI，比较麻烦）。点一下不会立刻创建新对话。后面再通过 Agent 的判断是否需要新建对话。（需要提示词工程）
3. 不需要模型 Picker，可以智能判断任务需求（是否困难，是否多模态）（需要提示词工程），选择思考强度与模型
4. 支持写作工具（需要提示词工程），实现上，就是提供文件 Edit tools（一次性写入，修改部分）。不支持脚本，只支持 txt, md, svg
5. 支持上下文压缩（需要提示词工程）
6. 给每个用户分配 credits。默认为 0。目前只有管理员能 top-up。
7. 暂时不考虑对话的离线可用性。

工程上：

1. 命名：数据库使用 ai_*
2. 一个用户的所有文件用一个 zip 装着（store，这块用 fflate）。为了避免奇怪的文件 id，zip 使用一个 catalog.json 维护目录结构与文件名。如果资料超过 10MB 拒绝保存（atomic，但是可以删除）。组织方式在提示词工程里体现，语义化目录层级（不超过两级为佳）。
3. 提供一个 models.json（放在 worktree/secrets 下，与 HTTPS 证书一样，都是直接复制到生产环境上，不需要加密啥的）。数据模型是：这个项目的 Harness 提供一系列做某件事情的 Model placeholder，然后 models.json 关联这些 placeholder 到具体的模型里。错误时可重试。

```pseudo code
type OpenAIProvider = {
    type: "openai";
    baseUrl: string;
    token: string;
}

type ProviderModel = {
    // Pricing, 以 credits 计
    cachedInput: number;
    input: number;
    output: number;

// 这个不一定是官方参数，很多模型阶梯计价也分开看。
// 此外，有些模型长上下文性能下降，这个可以改低点。
    contextSize: number;

    provider: string;
    model: string;
}

type Model = {
    models: string[];
}
```

- 遵循提示词工程的最佳实践，构思一套切实可行的完整 Agent work loop。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见。
- 现有 Infrastructure 可按需扩展。工程上合适最好就合并，避免又产生一堆新的 Infra。
- 服务端 schema 如有需要，可 bump。
- 编码习惯方面，写零零散散的 helper function 时，请给他们分组；请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。
- 按照本项目的错误处理、设计模式进行设计。领域内的设计，自己构思。
