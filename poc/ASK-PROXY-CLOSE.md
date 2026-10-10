# 源码审查：TUI Proxy 导致 hideOverlay 替换残留

2026-10-10：首先确认两个现有补丁存在真实的 Proxy 兼容缺陷，并记录下列修复前证据。随后按用户要求修复；修复验证见本文末尾。此前撤回的同步刷新改动没有恢复。

## 具体机制

Pi 1.1.0 的 `InteractiveMode` 构造函数将 `this.ui` 设为 `createInteractiveTuiReference(() => this.renderer)`。扩展 custom factory 得到的是这个稳定引用 Proxy，而非裸 renderer。

`dist/modes/interactive/tui-renderer.js` 的 `createInteractiveTuiReference`：

- Proxy target 是空对象 `{}`。
- `get` 和 `set` 转发到当前 renderer。
- 没有 `getOwnPropertyDescriptor`、`defineProperty` 或 `deleteProperty` trap。

`extensions/pi-custom-overlay/overlay-close.ts:25` 和 `extensions/rpiv-ask-user-question/ask-timeout.ts:61` 都使用同样的临时替换流程：读取自身属性描述符，赋值替换 `hideOverlay`，调用 done，最后恢复属性描述符或删除自身属性。

在真实 Proxy 上，读取描述符得到空 target 的 `undefined`，赋值却实际改了 renderer；`finally` 删除的是空 target 的属性，renderer 上的替换函数没有被恢复。因此“只在同步 done 期间替换”的代码注释与实际行为不符。

残留函数关闭的是旧窗口的 handle。旧窗口已从栈中移除，再调用该函数会成为 no-op，新窗口仍留在栈中。

原生 `showExtensionCustom` 的 done 在 `this.ui.hideOverlay()` 之后就 `resolve(result)`，并不检查浮层是否真的移除。因此污染后的原生关闭路径可以出现工具成功返回、窗口仍存在的状态。

## 受控 PoC

```sh
node poc/ask-proxy-close.ts --expect-bug
```

PoC 使用实际 `createInteractiveTuiReference`、原生 custom 生命周期、真实问卷插件及主屏/全屏 renderer。没有人为阻塞渲染。

| 补丁 | 第一次正常问卷提交 | renderer 方法残留 | 后续直接原生 hide | 撤除包装后再次提交原生问卷 |
| --- | --- | --- | --- | --- |
| 无 | 正常关闭 | 无 | 正常关闭 | 正常关闭 |
| 仅 custom 关闭补丁 | 正常关闭 | 有 | 新浮层仍在 | 答案返回，问卷和焦点仍在 |
| 仅问卷 timeout 包装 | 正常关闭 | 有 | 新浮层仍在 | 答案返回，问卷和焦点仍在 |
| 两者同时 | 正常关闭 | 有 | 新浮层仍在 | 答案返回，问卷和焦点仍在 |

普通和全屏模式均得到上述结果。8 个组合断言全部通过。最后一列故意卸载包装以验证残留方法的后果；它不等同于证明普通 `/reload` 一定会留下未包装的问卷。

以上命令针对修复前源码；修复后的默认命令检查缺陷不再发生。

## 真实 CLI 核验

复用 `ask-submit-pty.py`，只给被动观察器新增 raw renderer 与 reference 的自身属性记录。全部安装包、全屏模式下完成 5 次正常问卷提交。每次在关闭 2 秒后：

- `rendererHasOwnHideOverlay: true`
- `referenceHasOwnHideOverlay: false`
- 问卷浮层已关闭，焦点为 CustomEditor。

这证明方法残留发生于真实 CLI，并解释了此前连续提交 PoC 为什么仍能通过：每次受包装的关闭回调会再次安装指向当前窗口的函数，当次关闭有效，但随后恢复失败。

原始 CLI 证据目录：`/var/folders/gl/fdb2hp6d7g39741y8_4rfm3m0000gn/T/pi-local-ask-poc-_rledf04`。受控矩阵与真实 CLI 观察汇总见 [ask-proxy-close-results.json](ask-proxy-close-results.json)。TypeScript 检查通过。

## 与用户现场的关系

方法污染和原生关闭失效已经证实；在受控卸载流程中，真实问卷的“结果返回但确认框残留”也已复现。尚未证明原会话在提交时恰好走到了这个失效路径。正常包装持续有效时，连续提交仍可正常关闭。

源码还揭示两个需要区分的路径：

- TUI 输入分发在 `handleInput` 结束后调用 `requestImmediateRender()`，所以把正常 Enter 提交归因于普通 16ms 刷新排队不充分。
- TUI 处于 `stopped` 时，刷新调度不会绘制；全屏 renderer 在 `altScreenActive` 为 false 时也不绘制。问卷外部编辑器会停止 TUI，但其 `finally` 明确重启，尚未发现普通提交可以自行漏掉重启的路径。

普通模式切换并非一个直接解释：`switchTuiMode` 明确拒绝在有浮层时切换 renderer。正常 custom 挂载也有 `closed` 检查，避免 done 先完成后再挂载组件。

最优先的后续验证应把真实 Proxy 纳入关闭/卸载测试，并在实际卡住现场记录当前关闭方法、浮层栈及包装是否仍有效，再决定生产修复范围。

## 修复

两个入口共用 `extensions/pi-custom-overlay/close-overlay.ts`。Pi 的引用 Proxy 将方法调用转发到当前 renderer，继承的 `valueOf()` 因而返回真实 receiver；关闭时用它定位当前 renderer，将属性描述符读取、赋值和恢复都作用于同一个对象。裸 TUI 的 `valueOf()` 返回自身。

仍只在同步 native done 期间把关闭目标限定为当前窗口的 handle。未挂载时不移除其他窗口。`finally` 恢复原有自身属性描述符；原来是继承方法时删除真实 renderer 上的临时自身属性。嵌套的 timeout/custom 包装各自恢复上一层，最终恢复原生方法及其身份，不留下绑定函数链。未添加同步渲染或全屏重绘。

回归测试先在旧实现上失败，再在修复后通过。重跑：

```sh
node poc/ask-proxy-close.ts
node --test tests/ask-proxy-close.test.ts tests/close-overlay.test.ts tests/custom-overlay-close.test.ts
```

默认 PoC 对主屏/全屏、无补丁/custom/timeout/两者组合共 8 个场景断言：原生方法身份恢复、后续直接原生关闭有效、卸载包装后真实问卷仍正常提交且关闭。timeout/组合还检查遮挡时 abort、闲置超时及计时器清理。

新增 helper 测试覆盖裸对象/真实 Proxy 的嵌套异常、原属性描述符和遮挡窗口保护，以及 stable reference 切换 renderer 后的关闭行为。原 custom 生命周期测试默认改为真实 Proxy，遮挡测试同时保留裸 TUI 对照。

修复后全量 95 项测试和 TypeScript 检查通过。仅将公共 helper 与两个关闭入口同步到本机安装副本，再启动两个新的真实 CLI 隔离实例验证，共 10 次提交：一组默认超时，另一组关闭超时并持续输出、提交同时调整尺寸。全部窗口正常关闭、输入框命令正常；每轮关闭 2 秒后的 raw renderer 均 `rendererHasOwnHideOverlay: false`，对比修复前的 `true`。修复前与修复后的矩阵、CLI 证据目录保存在同一份 `ask-proxy-close-results.json` 中。

已经被旧代码污染的运行中 renderer 无法靠这一修复确定性识别并清理：它也可能存在其他扩展合法安装的自身方法。因此更新后应重启 Pi，以新的 renderer 加载修复，而非依靠单独 `/reload`。
