# Submit 后问卷残留：真实 CLI PoC

2026-10-10：在撤回同步刷新改动后，完成 7 组、共 35 次提交，未复现“答案已返回、agent 已继续，但确认框持续不消失”。这不是根因已解决的证明；本次没有新增生产修复。

后续源码审查发现并验证了 TUI Proxy 上的方法恢复缺陷，见 [ASK-PROXY-CLOSE.md](ASK-PROXY-CLOSE.md)。该缺陷在受控卸载包装后可造成真实问卷返回结果但仍残留，尚未确认原现场的触发路径；不改变本文连续正常提交的实验结果。

工作区和本机安装副本的 `extensions/pi-custom-overlay/overlay-close.ts` 均恢复为本次修改前的代码。新增同步刷新测试及测试替身中的 `renderNow` 也已移除。此前的按浮层句柄关闭补丁保留。

## 方法

- 使用本机实际 Pi 1.1.0 CLI、问卷插件 2.12.0 和 PTY。
- 全扩展场景使用本机安装的 21 个包，隔离实例加载 28 个扩展（包括 PoC provider 和观察器）。不复制真实会话或 `auth.json`，不调用远端模型。
- 离线 provider 生成问卷；前两题的标题、默认选项与报告现场一致：DeviceName → 系统主机名，Discoverable → 默认关闭。
- 每组在同一会话中依次提交 2、3、4、2、2 题，第四轮使用 Kitty 编码 Enter，其余使用普通 Enter。历史随轮次增长。
- 通过 `pyte` 解码实际 PTY 输出，保存确认页、提交后约 50ms/500ms/2s 的可见画面；不手动调用刷新。等待工具返回和 agent 后续输出，再执行 `/poc-ping` 验证主输入框。
- 可选观察器记录浮层、焦点、停止/刷新状态和渲染缓存，在关闭后 50ms/500ms/2s 取样。观察器不请求刷新，但包装了原生 custom 方法；无观察器对照组用于检查此包装是否影响结果。
- 持续输出场景在提交后分 100 次输出，每次间隔 25ms。尺寸变化场景在发送 Submit Enter 后立即改变 PTY 尺寸并发送 SIGWINCH。
- 三类安装 autopatcher 全部关闭，避免修改共享插件安装代码。测试实例加载的现有扩展仍是实际可执行代码，并非操作系统沙箱。

## 结果

| 场景 | 完整提交次数 | 持续残留 | 主输入框命令 |
| --- | ---: | --- | --- |
| 全屏、全部包、60 秒超时、观察器 | 5 | 未复现 | 全部成功 |
| 全屏、全部包、不加载观察器 | 5 | 未复现 | 全部成功 |
| 普通主屏、全部包 | 5 | 未复现 | 全部成功 |
| 全屏、全部包、关闭超时 | 5 | 未复现 | 全部成功 |
| 全屏、仅问卷与增强包、100×24 | 5 | 未复现 | 全部成功 |
| 全屏、全部包、持续输出、提交同时改变尺寸 | 5 | 未复现 | 全部成功 |
| 普通主屏、全部包、持续输出和增长的历史 | 5 | 未复现 | 全部成功 |

35 次均正常返回答案，`cancelled: false`，答案数正确。PTY 的三次延迟取样均没有确认框。启用观察器的组，2 秒取样均无浮层且画面没有确认框，焦点回到 CustomEditor。

汇总及原始证据目录见 [ask-submit-results.json](ask-submit-results.json)。各目录包含 `environment.json`、`events.jsonl`、`pty-output.bin`、`terminal.log`、逐轮画面和 `summary.json`。这些原始证据位于本机临时目录，可能被系统清理。

计数仅包含完整提交并通过输入框命令检查的轮次。早期脚本等待了错误的题目文案，未完成提交的启动不计入结果。

撤回后的全量检查：89 项测试通过，TypeScript 检查通过。

## 重跑

```sh
python3 -m venv /tmp/pi-submit-poc-venv
/tmp/pi-submit-poc-venv/bin/pip install pyte

/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --no-observer
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --mode main
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --timeout-ms 0
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --minimal --columns 100 --rows 24
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --stream-followup --resize-on-submit
/tmp/pi-submit-poc-venv/bin/python poc/ask-submit-pty.py --mode main --stream-followup
```

脚本假定本机 managed Pi 版本为 1.1.0，以及 `~/.pi/agent/settings.json` 中包的位置与 `prepare-local-pi.py` 的映射一致。每次重跑创建新的隔离目录并输出其路径。

## 尚未覆盖

没有复制原会话的内存状态、恢复/重载历史、同时运行的工具或目标任务状态。PTY 的终端解码器也不能替代用户实际终端软件。没有模拟人为阻塞事件循环来制造残留，也没有把提交瞬间、正常刷新前的缓存当成持续卡住。

下一步需要在实际卡住的进程中记录：问卷浮层是否仍存在、焦点指向哪个组件、TUI 是否停止、是否存在待刷新状态，以及当时的终端输入编码和屏幕输出。拿到该现场后，才能区分浮层生命周期错误与终端绘制问题。
