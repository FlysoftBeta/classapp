完全移除现有的 Blob reader。
目前的 Blob reader 的设计是，服务端渲染成适合设备 zoom * dpr 的 image/png，再回传给客户端。
初始动机：

1. 目标浏览器是 M70-M80，不支持啥 PDF.js
2. PDF 不好流式传输，再加上当时我认为目标环境无法缓存数据
3. 最终导致那时，下载 PDF 客户端解析变的完全不可能
   这样有几个问题：
4. 服务端不敢物化 image，一是因为 rasterized 后体积膨胀很严重，二是移除原来的版本后无法再次物化。因此必须要反复用 PDF.js 渲染，效率很低。
5. 客户端无法离线使用这些资源。

注：我说的是 249c7678ceecf948ada6c09bd3a556567660c4d5(HEAD) 之前的情况，这个 commit 本身 AI 私自把 PDFjs 引入到客户端了。这是不对的。以之前的渲染架构为准。

不过，既然现在客户端有存储 blob 的 infrastructure 了，我觉得是时候对这个不合理的架构做出变化了。
新设计的思路是，上传文档时进行渲染，但是渲染成 HTML(文字+SVG)+Blob(二进制的，例如 image/png) 的形式。这种格式压缩率很高，还只需要渲染一次就可以了。
此外，这种架构适用于任何只读电子文档，PDF与Epub理论上都可以接过来。格式上请认真阅读下面的文档，因为我说的很不准确。

实际实现上，我用 poppler 写了一个小程序，将一个 pdf 转换为一个 .pdrb (PDF renderer bundle)。虽然说 .pdrb 最初是我给 PDF 设计的，但是我发现它好像也不一定只能给 PDF 用。所以新模块先叫 Bundle reader。

一个 .pdrb 是一个私有的归档格式，zstd 压缩了所有文本部分，图像全部转成了 webp，并带了一个 zstd 字典。
具体格式见 /home/flysoft/projects/classapp-next/lib/poppler/utils/pdfrender-format.md，
Parser 示例是 /home/flysoft/projects/classapp-next/lib/poppler/examples/pdfrender-bundle-parser.mjs。
预编译产物在 /home/flysoft/projects/classapp-next/lib/poppler-prebuilt，需要打包进部署包。

此外，为了解决客户端解压 zstd，我写了个 wrapper 库：/home/flysoft/projects/classapp-next/lib/zstd-web。它应该还缺少自定义字典功能。

你要做的：
一、实现 Bundle 的渐进传输

当然，我不是让你直接 stream bundle 本身。Bundle 毕竟就是个压缩包，它的 placement 顺序其实是乱的，不按阅读顺序的。我也不想让客户端打开第一页就下整个 bundle，蛮麻烦的。

我希望你能设计的，就是传输的协议。例如，加载第一页，顺便拉来一堆依赖。

用 Extent infra，存储这些零散的文件，存储保留 Zstd 压缩。使用时，再用 zstd-web 解压缩。

不变量：现有的 article 永远不会修改，只有可能被删除。因此不用设计 revision 机制啥的。

二、实现阅读器本身。

DOM方面，
外置资源通过 Object.createObjectURL 传入，不用 HTTP API 那套。数据从 Extent infra 中取。
HTML 渲染用 frame/iframe。但其实这里我也不太清楚怎么传一个 HTML 进去渲染。注意遵循防 XSS 最佳实践就好（尽管 pdfrenderer 理论上已经过滤了一次）。

内容呈现方面，用 Infini 来实现无限滚动体验。需要注意一些常见 pitfalls。

要求

- 尽量不要参考现有的实现，他们都是 poorly implemented 的。我正是希望你能推翻这些糟糕的设计与代码。
- 允许你自由设计，你需要细致评估以上方案，提出你的深刻洞见。
- 改动不限制 scope。虽然主要改的是客户端，其他也能改。
- 编码习惯方面，写零零散散的 helper function 时，请给他们分组；请在重要入口处简要用注释说明流程，偏难怪的点可适度添加注释，注释使用英文。

先评估这套方案。
