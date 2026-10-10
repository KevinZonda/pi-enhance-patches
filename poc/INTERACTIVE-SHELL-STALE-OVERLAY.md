# Interactive shell 退出后浮层卡死 PoC

运行：

```sh
node poc/interactive-shell-stale-overlay.mjs
```

默认读取本机 `~/.pi/agent/npm/node_modules/pi-interactive-shell`；其他安装位置用
`PI_INTERACTIVE_SHELL_TEST_DIR` 指定。需要项目的 npm 开发依赖，完整运行约两分钟。
输出目录包含版本和源码 SHA-256、逐场景事件、终端输出以及卡死浮层的文本画面。
断言失败会返回非零退出码；所有测试 PTY 都在 `finally` 清理。

## 已确认的缺陷

Pi 1.1.0 的 `InteractiveMode.showExtensionCustom()` 在 `done()` 中调用
`this.ui.hideOverlay()`，移除栈顶浮层。它没有使用该组件的 `OverlayHandle.hide()`。
因此，只要 shell 上面还有一个浮层，shell 完成时就可能移除错误的组件。

复现步骤：

1. 用已安装的 `InteractiveShellOverlay` 启动真实 `/bin/sh` PTY。
   命令仅打印模拟 sudo 失败文本后 `exit 1`，不运行 sudo。
2. 等实际退出和计时器第一次 tick，确认显示 `Closing in 9s`。
3. 加入另一个 `nonCapturing` 浮层，保持 shell 的键盘焦点。
4. 向真实 TUI 输入 Enter，触发 shell 的完成回调。
5. Pi 移除了后加入的浮层，却调用了 shell 的 `dispose()`。shell 仍在浮层栈中。

此时可观测的状态：

- shell 的 `finished` 为 `true`，`countdownInterval` 为 `null`。
- `ctx.ui.custom()` 对应 promise 已完成；协调器的 `overlayOpen` 为 `false`。
- shell 仍可见且持有焦点，倒计时保持 9。
- Enter 和 Ctrl+T 被 `finished` 的保护条件挡住。
- Alt+Shift+F 的全局监听器看到 `overlayOpen === false`，不再切换焦点；
  组件自己的 unfocus 回调也因协调器的句柄已清除而无效。
- 输入到不了编辑器。

这能够同时复现用户报告的三个症状：浮层关不掉、倒计时不动、焦点快捷键无效。
自动倒计时关闭和 `ReattachOverlay` 也有相同的移除错误；自动关闭后计数为 0，
不要求一定卡在 9。

## 验证结果

本机验证版本：Pi 1.1.0、pi-interactive-shell 0.17.0、Node v26.10.0、macOS。
主屏 `TuiMainScreen` 与全屏 `TuiAltScreen` 各 12 个场景，共 24 个断言场景通过。

| 场景 | 主屏 | 全屏 |
| --- | --- | --- |
| 普通 Enter、Kitty Enter、Ctrl+T | 正常关闭 | 正常关闭 |
| Kitty Alt+Shift+F 切出、切入后 Enter | 正常关闭 | 正常关闭 |
| 没有其他浮层，实际 10 秒自动关闭 | 正常关闭 | 正常关闭 |
| 其他浮层在上，9 秒时 Enter | 复现卡死 | 复现卡死 |
| 其他浮层在上，实际自动关闭 | 复现卡死 | 复现卡死 |
| 上述两项在 PoC 中改为句柄关闭 | 正常关闭，保留其他浮层 | 正常关闭，保留其他浮层 |
| 已退出 PTY 的 reattach，Enter | 正常关闭 | 正常关闭 |
| reattach，其他浮层在上，Enter | 复现卡死 | 复现卡死 |
| 上项在 PoC 中改为句柄关闭 | 正常关闭，保留其他浮层 | 正常关闭，保留其他浮层 |

本轮完整证据：
`/var/folders/gl/fdb2hp6d7g39741y8_4rfm3m0000gn/T/pi-shell-overlay-poc-Z1mpoN/`。
每次重跑会生成独立的新目录。

生产包装实现验证的第二轮证据：
`/var/folders/gl/fdb2hp6d7g39741y8_4rfm3m0000gn/T/pi-shell-overlay-poc-jcgHtM/`。
此外，`tests/custom-overlay-close.test.ts` 的 8 个回归测试覆盖主屏/全屏浮层重叠、
重复关闭、同步/异步工厂在挂载前完成、inline 对话框、重新安装和退出恢复、
关闭抛错后的方法恢复。全套 `npm test` 共 85 项通过，类型检查和打包预检通过。

## 修复方向与证据边界

应让 Pi 的自定义浮层完成回调移除它自己的句柄，而非无条件弹出栈顶。
PoC 的 `scopedClose` 现在调用本包的 `installCustomOverlayClose()`，仅在同步完成
回调期间将 `hideOverlay()` 定向到自己的 `handle.hide()`，验证生产包装实现，
并验证其他浮层和编辑器输入都保留正常行为。模块在顶层入口默认注册。
未修改 Pi 或已安装 shell 插件的源码。

使用了实际安装的 shell/reattach 类、PTY、协调器，以及项目依赖的 Pi 原生
custom 生命周期、TUI 输入路由和渲染器；外层终端是测试适配器，不操作用户终端。
焦点监听器按已安装 shell 的 `index.ts` 重建，未加载所有第三方扩展。
其他浮层是 PoC 主动加入的组件；被 kill 的原会话没有浮层栈日志，无法确认当时
是否存在这个条件，或具体是哪个扩展加入了浮层。

因此，这里确认的是一个真实的、症状吻合的关闭缺陷，并非原会话根因的直接取证。
没有真实密码输入、提权、VPN 启动、远程操作、模型调用或安装文件改动。
