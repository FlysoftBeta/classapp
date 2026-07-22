# TypeScript 与 React API 指南

本章使用真实公开 API 名称；设计原理请读前七章。字段的最终类型与简明语义位于源码 JSDoc。

## 1. 推荐入口

React 应用通常使用：

```tsx
import { Infini2List, useInfini2 } from "../lib/infini2";

function Timeline() {
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
      getId: (item) => item.id,
      getCursor: (item) => item.cursor,
    },
    estimateSize: () => 72,
    defaultItemEstimate: 72,
    initial: { cursor: null },
    residentBefore: 40,
    residentAfter: 40,
  });

  if (snapshot.phase.status === "failed") {
    return <button onClick={() => controller.retry()}>Retry</button>;
  }
  return (
    <Infini2List
      controller={controller}
      paddingStart={64}
      renderItem={(item) => <Message item={item} />}
    />
  );
}
```

`useInfini2` 在组件生命周期内只创建一个 controller；传入 config 视为初始配置，不因每次 render
换对象而重建。需要动态修改 viewport 选项时通过组件 props/DOM host API；更换 Provider 或内容
身份域时应重新挂载拥有者组件。

## 2. Infini2Controller

非 React 或需要自定义渲染时直接创建 controller：

```ts
const controller = new Infini2Controller(config);
const unsubscribe = controller.subscribe(render);
controller.start();
// ...
unsubscribe();
controller.dispose();
```

### 生命周期

- `start()`：幂等地从 dormant 启动 bootstrap；
- `subscribe()`：状态改变通知，回调内再调用 `getSnapshot()`；
- `getSnapshot()`：同 revision 返回稳定对象，适配 `useSyncExternalStore`；
- `dispose()`：幂等终止，之后除 dispose 外的方法不可再用。

### 视图和布局

- `setView()`：提交 host-local scroll、viewport、inset 和可选 overscan；
- `measure()`：批量提交 handle 高度，返回实际改变数；
- `captureAnchor()`：在几何 mutation 前捕获补偿水位线；
- `takeScrollCorrection()`：仅物理执行层消费绝对局部 scroll 目标；
- `commitLayout()`：ACK 某 revision 已挂载的 handle 集合；
- `getVisibleItem()`：只读当前水位线 item，不改变补偿状态。

### 数据操作

- `jump(target, options)`：命令式离散定位；需要 `targetToCursor`；
- `insertExternal()`：在 stable ID 前/后插入一段通知数据；
- `deleteExternal()`：删除并 tombstone IDs；
- `updateExternal()`：替换内容对象，不改变顺序；
- `reopen()`：把服务端曾 exhausted 的方向重新标为 open；
- `trimBuffer()`：显式淘汰某方向 Resident 外端内容；
- `pin()`：临时让某 item 保持布局；
- `retry()`：重试当前前台失败，非 failed 时无操作。

## 3. Snapshot

Snapshot 是只读观察值，主要字段分组：

| 分组      | 字段                                                                    | 用途              |
| --------- | ----------------------------------------------------------------------- | ----------------- |
| 版本/状态 | `revision`, `phase`, `layoutRevision`                                   | UI 订阅、布局事务 |
| 当前布局  | `layoutItems`, `candidate`                                              | 渲染与隐藏预备    |
| 几何      | `surfaceExtent`, `islandOrigin`, `visible`, `layoutTarget`, `blankZone` | DOM 执行与诊断    |
| 驻留      | `residentCount`, `residentRange`, `bufferBefore`, `bufferAfter`         | 订阅和内存策略    |
| 已知主岛  | `mainItems`, `mainLength`, `mainExtent`                                 | 增量锚点与进度    |
| 拓扑      | `mainIsland`、两侧 stale ID                                             | 调试多岛关系      |
| 边/工作   | exhausted、loading、`effects`                                           | loading UI 与诊断 |
| Registry  | `getItem(handle)`, `getHandle(id)`                                      | DOM/业务身份桥接  |

不要修改数组或对象；也不要长期保存 layout item 的 start，它会随 prepend 和测量改变。业务持久化
阅读进度应保存 stable ID 和可选 item 内相对位置。

## 4. Phase 渲染建议

```tsx
switch (snapshot.phase.status) {
  case "dormant":
  case "bootstrapping":
    return snapshot.mainLength ? list : <Spinner />;
  case "seeking":
    return list; // 保留旧 main，可叠加轻量进度
  case "ready":
    return snapshot.phase.empty ? <Empty /> : list;
  case "failed":
    return (
      <ErrorView error={snapshot.phase.error} onRetry={controller.retry} />
    );
}
```

Edge loading 可从 `loadingBefore/loadingAfter` 单独显示，不要把所有背景请求都变成全屏 loading。

Controller 配置可提供可选的 `debug` 字符串。DOM adapter 的诊断事件会携带该 label；未设置时不
输出诊断日志。应用通常只在开发构建中传入，例如
`debug: import.meta.env.DEV ? "ChatMessageList" : undefined`。

## 5. Infini2DomHost

框架无关 DOM 适配需要提供：

- `container`：代表完整 scroll surface 的元素；
- `controller`；
- `createRow(item, id)`：创建最终 HTMLElement；
- 可选 `updateRow` 和 `disposeRow`；
- 可选 window/element `scrollHost` 和 viewport 参数。

Host 自动处理 scroll/resize、隐藏 candidate、ResizeObserver、flow-based live track、focus pin、
布局 ACK 和 scroll correction。Surface 保持完整滚动高度，当前连续 Layout 行共享一个 track
transform；新行先隐藏测量再在下一帧提交。`flushNow()` 用于测试或必须同步读取已 reconcile 快照
的场景；正常 UI 不应在每个事件手动调用。

`setViewportOptions()` 可动态更新 inset、overscan 和 anchor ratio。`dispose()` 会移除所有监听和
调用 `disposeRow`，但 controller 生命周期仍由创建 controller 的所有者管理。

`scrollToItem(id, alignment)` 对已在 Layout 的行返回 `true`；对 Layout 外的 ID 返回 `false`，提示
调用方发起 `controller.jump()`。无论返回值为何，Host 都会保留最新物理对齐命令：re-bootstrap
完成、目标完成测量并进入 live track 后，再按真实 DOM rect 执行最终 start/center/end 对齐。

## 6. Infini2List

React 组件用 portal 保留每行组件状态。`renderItem` 应是纯渲染，不在其中直接调用 controller
mutation。`style.height` 不应由调用者覆盖，surface 高度由 host 管理；可以设置宽度、主题和其他
不影响协议的样式。`rowClassName` 应包含最终行所需的宽度/box-sizing 规则。

Window host 是默认值。Overflow element 必须在它已存在后传入；如果 ref 尚未准备，可在父组件
就绪后渲染列表。固定 overlay 用 padding props，流内 sticky 不重复传。

## 7. 阅读进度与恢复

```ts
const row = controller.getVisibleItem(0.25);
if (row) save({ id: row.id });
```

恢复时把业务 target 放进 `initial.target`，并提供：

- `targetToCursor(target)`：转为 bootstrap cursor；
- `locateTarget(items, target)`：从 page 选 stable ID；
- `initial.alignment`：期望对齐。

也可以在运行中 `jump(target, { alignment: "center" })`。

## 8. 外部通知接入

```ts
events.on("insert", (event) => {
  controller.insertExternal({
    anchor: event.anchorId,
    side: event.side,
    items: event.items,
  });
});
events.on("delete", ({ ids }) => controller.deleteExternal(ids));
events.on("update", ({ items }) => controller.updateExternal(items));
```

若服务端只想订阅附近事件，可观察 `snapshot.residentRange` 更新订阅，但切换期间仍必须保证事件
最终不漏。

## 9. 高级 Raw API

`runtime` 导出的数值 API 是实现自定义执行层或核心诊断的高级接口。它只接受非零数值 handle、
数字 enum 和 extent，不保存业务 item/cursor，也不替你校验 Provider。调用者必须完整实现 effect
runner、candidate measure/commit、released handle 回收和 correction ACK。普通应用不应绕过
`Infini2Controller`。

Wasm module getter 共享一个无 imports 的实例。多个 raw engine 是同一 Wasm instance 中的独立
heap 对象；每个都必须 dispose。
