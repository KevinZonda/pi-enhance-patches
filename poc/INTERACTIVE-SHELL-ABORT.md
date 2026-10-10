# Interactive shell 忽略工具取消信号

```sh
node poc/interactive-shell-abort.mjs --baseline
node poc/interactive-shell-abort.mjs
node --test tests/interactive-shell-abort.test.ts
```

PoC 复制本机安装的 `pi-interactive-shell 0.17.0`，只对临时副本应用补丁。
可通过 `PI_INTERACTIVE_SHELL_TEST_DIR` 指定安装目录。
使用实际注册的工具、主屏/全屏 TUI、原生 CustomEditor 和自定义浮层关闭流程。
模型调用、密码输入、提权、VPN 和远端操作均不参与测试。

## 缺陷与修复

原插件 `execute(_toolCallId, params, _signal, onUpdate, ctx)` 丢弃 `_signal`。
限流查询内部用 `Promise.race()` 等待定时器或会话完成，取消不能结束等待。
Pi 核心确实收到 Esc 并调用 `abort()`，但它仍需等工具返回，因而画面停留在 working。
阻塞式 attach 的自定义窗口也没有收到工具取消信号。

补丁将信号传入查询等待和本次工具调用的 UI 上下文。查询取消会抛出 AbortError，
清理定时器、完成订阅和 abort 监听器，并且不会再次读出或消耗输出，不杀会话进程。
阻塞窗口取消时使用插件已有的 `killSession()`，让原生完成流程处理结果、资源和协调器。
本包另一个运行时修复负责按窗口自己的句柄关闭，保留覆盖它的其他浮层。

完成订阅新增退订函数；完成广播遍历回调快照，避免某个等待者退订时跳过下一个等待者。
工具返回时解除 UI 的取消监听器，所以正常返回的非阻塞窗口和任务不会被旧信号杀掉。
授权对话框接收信号，并在授权结束后再次检查取消，避免取消后继续启动。

## 本机结果

Pi 1.1.0、pi-interactive-shell 0.17.0、Node v26.10.0、macOS：

- 基线中，通过实际编辑器输入 Esc，信号已取消，但实际查询工具仍未返回。
- 补丁中，同一路径约 1–2 毫秒返回 AbortError，且完成订阅、abort 监听器都为零。
- 主屏和全屏的真实 `sleep 30` PTY：阻塞式 attach 取消后窗口关闭；
  保留其他浮层，返回编辑器焦点，并通过 PID 存在检查确认测试进程实际退出。
- 已返回的 hands-free attach，在旧调用信号被取消后保持窗口和进程运行。
- 取消、完成、超时、同步完成的竞争路径均能清理订阅；60 秒定时器不会使 PoC 挂住。
- 两个等待者都能收到完成通知，即使第一个在回调内退订。
- 已取消的信号在工具入口被拒绝。
- 补丁后的完整插件源码使用宿主 peer 类型通过严格 TypeScript 检查。

`tests/interactive-shell-abort.test.ts` 同时验证版本限制、原子预检、源码不匹配、
锁所有权、幂等应用、撤销以及启动开关。

## 限制

PoC 的外层终端是测试适配器，查询对象通过真实 session manager 注册的测试会话，
用于稳定触发限流；阻塞 attach 使用真实 PTY。未复制原用户会话或所有已安装扩展。
它确认插件内取消缺陷，不能直接证明某个现场的 Esc 未响应必定由此引起。

窗口处于 SHELL FOCUSED 时，Esc 仍发往子进程；需要先切回编辑器才能中断 Pi。
此补丁不把 Esc 改成全局强制终止键。它修复已验证的查询等待、阻塞窗口和授权路径，
不声称所有第三方服务调用都支持立即取消。

进程取消复用上游行为。macOS 的测试中偶尔出现原插件的 SIGKILL `EPERM` 日志，
但对应测试进程通过 PID 检查确认退出；不将这个日志当成所有后代进程都已终止的证明。
