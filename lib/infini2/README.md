# Infini2

Infini2 是平台无关的双向无限滚动核心，以及其 DOM/React 适配层。完整设计、状态机、
Provider 契约、API 指南与验收清单见 [`docs/`](./docs/README.md)。

## 最小用法

应用启动时先异步编译一次内联 Wasm，再创建任何 controller：

```ts
await initializeInfini2Wasm();
```

```tsx
const { controller, snapshot } = useInfini2({
  provider: {
    bootstrap: ({ cursor, targetSize, signal }) =>
      api.bootstrap({ cursor, targetSize, signal }),
    fetch: ({ cursor, direction, targetSize, signal }) =>
      api.fetch({ cursor, direction, targetSize, signal }),
    locateOffset: ({ anchor, signedItemOffset, signal }) =>
      api.locateOffset({ anchor, signedItemOffset, signal }),
  },
  ops: {
    getId: (message) => message.id,
    getCursor: (message) => message.cursor,
  },
  estimateSize: () => 72,
  defaultItemEstimate: 72,
  initial: { cursor: null },
  layoutBefore: 800,
  layoutAfter: 800,
  residentBefore: 40,
  residentAfter: 40,
});

return (
  <Infini2List
    controller={controller}
    renderItem={(message) => <Message message={message} />}
  />
);
```

`Infini2List` 默认使用 `window`；overflow 容器通过 `scrollHost` 传入。固定顶栏/底栏
使用 `paddingStart`/`paddingEnd`。普通文档流中的 sticky 项本身占位，不应重复计入 padding。
`layoutBefore/layoutAfter` 未指定时，各自默认为一个当前 viewport。

## Provider 契约

- page 必须是 content order 中的连续切片，并且单页内 stable ID 不重复。
- stable ID 永不复用；顺序一旦确定不可移动，需要“移动”时改用新 ID。
- response 至少与请求发起时一样新。外部 insert/delete 通知可异步，但必须有序、
  不遗漏且最终到达；Infini2 会把请求期间的通知 journal 重放到 response 上。
- 空 page 必须把相关方向标记为 exhausted；bootstrap 空 page 必须两端 exhausted。
- `targetSize` 是期望覆盖的像素量。provider 应尽可能一次返回足够的连续项。
- `locateOffset` 只在进入离散 Blank Predict Zone 时需要。普通相邻 edge load 不调用它。
- 不需要、也不接受 provider revision/generation。

## 构建与测试

```sh
npm run infini2:build
npm run test:infini2
npm run docs:infini2
```

Wasm 没有 imports，字节以 TypeScript base64 模块内联进单一 client bundle；运行时不
请求额外 `.wasm` 资源。
