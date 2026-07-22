# 测试、构建与验收

## 1. 测试原则

无限滚动错误常由多个异步几何事件组合产生，单元测试和真实浏览器 E2E 缺一不可。Work loop 不
要求滚动连续，因此测试应直接设置 scrollTop，覆盖大跨度跳变和事件合并。

## 2. Rust 核心单元测试

至少覆盖：

- 随机插入、删除、测量与 Vec oracle 顺序/extent 对拍；
- 10 万 item 下 rank、offset、layout range 的访问节点复杂度；
- Visible/Layout/20V 公式和 exhausted 边收缩；
- 动态 Resident 与两侧 Buffer 抑制；
- edge fetch 调度去重、failure latch/retry；
- ordered common anchors 合并与冲突丢 Stale；
- N 次无锚点删除 Stale；
- detached 结果、owner 合并后的请求重定向；
- mutation journal 阻止迟到复活；
- anchor 在 insert/delete/measure/trim/reopen/resize 后稳定；
- layout revision 旧 ACK 拒绝；
- pin 阻止卸载/淘汰；
- debug invariant validation。

## 3. TypeScript 单元测试

- Provider 输入 cursor/direction/targetSize 正确；
- stable ID registry 与 released 回收；
- duplicate ID、非法空 page、underfill 错误；
- phase 转换、foreground/background 错误隔离；
- retry 保留 intent；
- targetToCursor/locateTarget/alignment；
- snapshot identity 和字段映射；
- residentRange；
- update/insert/delete/reopen/trim API；
- dispose 后 Promise 完成被忽略。

## 4. 坐标测试

Window 与 element host 分别覆盖：surface 位于文档非零位置、host 自身滚动、border/clientTop、
非零 clientHeight、surface offset 在 correction 前变化、写入绝对目标。

## 5. Playwright E2E

真实浏览器至少验证：

- hidden staging 可测量且用户不可见；
- commit 使用同一 DOM node，不 clone/recreate；
- live 行处于同一 flow track 且不持有独立 transform；
- 连续滚动扩窗不会从 `performLayout` 同步读取 live row rect；
- append 后对尚在 staging 的末项执行 end scroll，测量提交后落在真实 surface bottom；
- 20V before Blank、动态末项高度和同帧 correction 下，end scroll 使用最新物理坐标；
- re-bootstrap 激活后合并 Stale prefix，target alignment 按最终 Main 序列重算；
- surface height = blank + main + blank；
- Layout 外行卸载，快速 scroll 不白屏；
- 直接大改 scrollTop 触发 Predict Zone；
- prepend、图片/字体导致 ResizeObserver 后 clientTop 不跳；
- viewport/inset resize 保持 anchor；
- exhausted 收缩 Blank Zone 时补偿正确；
- focus 行 pin，失焦后释放；
- element/window host；
- React portal 保留组件 state；
- React StrictMode effect replay 不泄漏或过早 dispose；
- re-bootstrap 保留旧 main，candidate 不 flicker；
- Provider 请求乱序、abort 被忽略、外部通知延迟。

测试断言优先使用 item `clientTop`、stable ID、节点对象身份和内部可观察事件，而不是依赖真实用户
smooth scroll 的时间曲线。

## 6. 构建

```sh
npm run infini2:build
npm run test:infini2
npm run docs:infini2
npm run build
```

Rust 核心构建为无 imports 的 Wasm，字节转为 TypeScript base64 模块，客户端运行时同步编译并共享
实例。生产 bundle 不应额外生成或请求 `.wasm` URL。ABI 变更必须同步提升版本、重建内联字节并
运行 browser test。

## 7. 文档验收

`docs:infini2` 必须：

- 检查 Markdown 相对链接存在；
- 排除外部 URL、锚点和代码示例；
- 以 `-D warnings` 运行 cargo doc；
- 因公开 Rust item 缺 rustdoc 而失败。

TypeScript JSDoc 由 `tsc --noEmit` 和 ESLint 做语法/类型验证；评审清单还应检查每个公开字段是否
写明单位、所有权、默认值、空值语义和失败行为。

## 8. 发布验收门槛

- Rust/TS/browser 测试全部通过；
- cargo doc 无 warning；
- 文档链接无断链；
- TypeScript 类型检查和 lint 通过；
- production build 通过且 dist 无独立 wasm；
- `git diff --check` 无 whitespace 错误；
- 新增公开 API 同步 JSDoc、rustdoc、API 指南和测试；
- 新增状态在类型上互斥，不产生“字段组合才知道非法”的隐式状态。

## 9. 性能回归

性能测试不要只看 wall-clock，应同时观察序列 diagnostics：访问节点数应随 `log n + k` 增长。
E2E 可统计一帧创建/销毁行数、layout pass 数和 observer batch 数。不要把机器噪声较大的绝对毫秒
作为唯一门槛。
