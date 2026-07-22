# Tomato

番茄小说网页端的 Node.js/TypeScript 客户端，提供：

- `TomatoClient.searchBooks`：使用池化的 Playwright Chromium 搜索；
- `TomatoClient.getCatalog`：从书籍 SSR 页面一次性解析完整目录；
- `TomatoClient.getChapter`：从官方页面、官方全文 API、浏览器和多个公共镜像中
  自动选择完整正文，并还原自定义字体 PUA 字符；
- `downloadBook`：逐章保存、断点续传并合并 TXT。

该模块是 **Node-only** 库。不要从 `client/` 浏览器代码导入；应在服务端、脚本或任务进程中使用。

## 安装

根项目已声明 `cheerio` 和 `playwright` 依赖。首次使用搜索功能前安装 Chromium：

```bash
npm install
npx playwright install chromium
```

目录、章节和下载使用 `fetch` + SSR HTML；Search 使用 Chromium。模块不再提供
CLI，应用通过服务层调用它。

## Client、浏览器池和配额

`Client` 是分层限流抽象：搜索请求的开始时间至少相隔 5 秒，目录与章节下载请求
至少相隔 0.5 秒；
`TomatoClient` 实现搜索、目录与章节能力。`BrowserPool` 统一负责 Chromium 的
惰性启动、上下文复用、池化、Stealth 与断线重建。服务端使用 `ClientPool` 分配
Client，并用 `DynamicCooldownAllocator` 给忙碌请求返回动态重试窗口。

## Search

```ts
import { TomatoClient } from "@/lib/tomato";

const client = new TomatoClient();
const books = await client.searchBooks("盗墓", {
  pages: 2, // 每页 10 条
  humanize: true,
  timeoutMs: 60_000,
});

for (const book of books) {
  console.log(book.book_id, book.book_name, book.author);
}
```

无头搜索默认：

1. 使用完整 Chromium 的 new-headless，而不是 headless shell；
2. 删除 `navigator.webdriver`、补齐 plugins、平台、屏幕和 WebGL 等常见指纹；
3. 通过 CDP 同步 UA、Client Hints 与 `navigator.userAgentData`；
4. 从首页停留后模拟鼠标移动和慢速输入，再进入搜索结果页。

这只降低误判，不保证绕过站点风控，也不会自动处理验证码。浏览器运行模式与
Stealth 在 `BrowserPool` 构造时统一配置。

## 完整目录

```ts
import { TomatoClient } from "@/lib/tomato";

const tomato = new TomatoClient({ timeoutMs: 20_000, retries: 4 });
const catalog = await tomato.getCatalog(
  "https://fanqienovel.com/page/6985246250434038815",
);

console.log(catalog.title, catalog.author, catalog.chapters.length);
console.log(catalog.chapters[0]);
```

`getCatalog` 同时接受书籍 ID 和 `/page/<id>` URL。

## 单章正文

```ts
const chapter = await tomato.getChapter(
  "https://fanqienovel.com/reader/6985746826670539295",
);

console.log(chapter.title);
console.log(chapter.source);
console.log(chapter.text);
```

`getChapter` 同时接受章节 ID 和 `/reader/<id>` URL。正文按段落保存在
`paragraphs`，`text` 是用换行连接后的内容，`source` 表示实际成功的后端。

默认正文回退顺序是：

1. 官方 Reader SSR；存在 SVIP/App 引导时判定为预览，不会写入下载结果；
2. 配置 Cookie 后尝试官方 `/api/reader/full`；
3. 配置 Cookie 或显式启用后，使用池化 Chromium 渲染并捕获官方全文响应；
4. 依次尝试 `DEFAULT_CHAPTER_MIRRORS` 中的公共全文镜像。

当前内置镜像包括 `fqdt` 的 `raw_full`、`fanqietc.com` 的带固定 Token proxy、
`fqdt content`，以及近期下载器使用过的 `sjmyzq` 和 `20071006` 后端。
`fanqietc` 按其公开前端的限制保持约 60 请求/分钟。镜像按健康度排列；连续失败
两次会熔断两分钟，防止失效地址拖慢每一章。公共镜像不是番茄官方服务，可能
失效、限流或返回错误内容；正式部署可以用 `chapterMirrors` 替换为自己的受控后端：

```ts
const tomato = new TomatoClient({
  chapterMirrors: [
    {
      name: "my-full-text-backend",
      url: "https://example.test/api/raw_full?item_id={chapterId}",
      timeoutMs: 5_000,
    },
  ],
  onChapterProviderAttempt(attempt) {
    console.log(attempt.source, attempt.status, attempt.error);
  },
});
```

若有番茄网页会员登录态，可让官方后端优先于公共镜像：

```ts
const tomato = new TomatoClient({
  fanqieCookie: process.env.FANQIE_COOKIE,
  browserChapterFallback: true,
});
```

Cookie 只用于请求，不会出现在 provider 回调和聚合错误中。不要把 Cookie 写入
源码、日志或提交到版本库。传入 `chapterMirrors: []` 可完全禁用公共镜像；传入
`tryAnonymousFullApi: true` 可在无 Cookie 时也尝试官方全文 API。

## 断点下载

```ts
import { downloadBook } from "@/lib/tomato";

const result = await downloadBook("6985246250434038815", {
  outputDir: "./downloads",
  start: 1,
  end: 10,
  delayMs: 800,
  onProgress(progress) {
    console.log(
      `[${progress.position}/${progress.total}]`,
      progress.status,
      progress.chapter.title,
      progress.source,
    );
  },
});

console.log(result.combinedPath, result.missingCount, result.failures);
```

输出结构：

```text
downloads/<书名>_<bookId>/
  catalog.json
  chapters/
    00001_<chapterId>.txt
    00002_<chapterId>.txt
  <书名>.txt
  failures.json          # 仅有失败章节时存在
```

再次运行默认跳过已完成章节；传入 `overwrite: true` 可强制覆盖。`start`/`end`
是从 1 开始且包含端点。可通过 `AbortSignal` 取消请求和章节间等待。

## 逆向说明

前端当前使用这些接口：

```text
GET /api/author/search/search_book/v1
GET /api/reader/full?itemId=<chapterId>
GET /api/reader/directory/detail?bookId=<bookId>
```

裸 HTTP 调用搜索/Reader API 可能返回 `200 + 空响应`，并在
`Bdturing-Verify` 响应头要求滑块验证。因此目录与正文优先解析公开 SSR HTML；
Search 则让站点 JavaScript 正常发请求并捕获响应。

正文使用 `DNMrHsV173Pd4pgy` 字体族，Reader 与 Search 分别使用两套 PUA
排列。本模块把两套映射分开解码；未知字符会原样保留，避免静默写入错误汉字。

请遵守站点条款、著作权规则与合理请求频率。Client 自带搜索 5 秒、目录与章节下载
0.5 秒的分层请求间隔。

Stealth 实现参考了
[ScrapFly 的 Puppeteer Stealth 指南](https://scrapfly.io/blog/posts/puppeteer-stealth-complete-guide)，
并额外保持 HTTP UA、Client Hints 与 `navigator.userAgentData` 的版本和平台一致。
