# 安装文件补丁

这里的补丁会修改安装文件，与图片、权限和问卷的运行时包装不同。
后台任务补丁与 Subagent 通知补丁均有启动 autopatcher（通知补丁默认关闭），也可手动 Apply/Revert。
只修改确认过的目标插件版本；先预检，再应用。更新或重新安装目标插件可能覆盖补丁。

## pi-background-tasks 2.6.9：全局任务缓存

文件：`pi-background-tasks-2.6.9-global-cache.patch`。
同时修改 `src/` 与实际加载的 `dist/`，无需构建插件；同步更新 `bg_run` 的目录说明。

将新任务目录从项目内 `.pi/tasks/` 改为：

```text
~/.pi/agent/cache/background-tasks/<项目路径的 SHA-256>/<会话ID>-<进程ID>/
```

- 使用 Pi 的 `getAgentDir()`，因此遵循 `PI_CODING_AGENT_DIR`。
- 项目 ID 基于真实路径，同一项目的符号链接不会产生另一份项目目录。
- 保留原会话/进程隔离，日志及元数据显示绝对路径。
- 只改变任务存储路径，不改变 shell 命令工作目录、完成通知或日志读取行为。
- 新建目录在 POSIX 下使用 `0700`；不修改已有目录权限。
- 覆盖复用任务 registry 的 shell、delegate、managed task 和 attested 输出。
  Fusion 的独立 `.pi/fusion/` 产物目录**不在本补丁范围内**。
- 不搬迁或删除原来的 `.pi/tasks/`，不自动清理全局缓存。

### 启动 autopatcher

增强包在 `session_start` 时检测 `bg_run` 是否已加载，以及默认 npm 安装目录中的插件。
确认包名/版本为 `pi-background-tasks 2.6.9` 后，使用 `git apply --reverse --check` 检测是否已应用。
未应用时取得互斥锁，重复检查，执行正向预检和写权限检查，再应用补丁。
已应用则不写文件；预检失败、非目标版本、无 Git 或无写权限时只提示跳过。

这是磁盘补丁，不会替换本次已加载的模块。首次应用后先等当前任务结束，再 `/reload` 或重启；
不会自动重载、终止任务或搬迁已有输出。插件加载顺序不影响下一次启动生效。
异常退出可能留下包根目录的 `.pi-enhance-global-cache.lock` 空目录；
确认没有 autopatcher 进程正在应用后，才可手动删除该空目录。

默认仅支持 `<Pi agent 目录>/npm/node_modules/pi-background-tasks`；其他安装位置仍需手动应用。
禁用自动补丁（不撤销已经应用的补丁）：

```bash
PI_ENHANCE_BACKGROUND_AUTOPATCH=0 pi
```

### Apply

先让任务结束并退出使用目标插件的 Pi。在**本增强包根目录**执行以下命令：

```bash
patch_file="$(pwd)/patches/pi-background-tasks-2.6.9-global-cache.patch"
plugin_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-background-tasks"

(
  cd "$plugin_dir" || exit 1
  version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")" || exit 1
  [ "$version" = "2.6.9" ] || { printf 'Unsupported version: %s\n' "$version" >&2; exit 1; }
  git apply --check "$patch_file" && git apply "$patch_file"
)
```

其他安装方式请把 `plugin_dir` 改成对应包根目录，目录中应同时包含 `src/` 和 `dist/`。
无需目标目录是 Git 仓库。重复应用或源码不匹配会报错；不要使用强制或部分应用。
成功后重新启动 Pi。仅修改文件不会改变已加载的插件或正在运行任务的路径。

确认已经应用：

```bash
(cd "$plugin_dir" && git apply --reverse --check "$patch_file")
```

### Revert

先结束任务并退出 Pi。若已安装增强包，请在后续启动中设置
`PI_ENHANCE_BACKGROUND_AUTOPATCH=0`（或停止加载本增强包），否则补丁会再次自动应用。
然后执行：

```bash
(cd "$plugin_dir" && git apply --reverse --check "$patch_file" && git apply --reverse "$patch_file")
```

重新启动后，新任务恢复原目录。已有全局缓存仍保留，不自动删除。
如果插件升级导致撤销预检失败，不要强行套用旧补丁。

### 验证

`tests/background-task-patch.test.ts` 在临时插件副本上应用与撤销，验证真实后台命令工作目录、
输出文件、元数据、`bg_logs`、项目隔离和目录权限；不会改动已安装的插件。
默认使用 Pi agent 目录中安装的 2.6.9；已打补丁的安装包也可作为输入，测试只在副本中撤销已知补丁。
可以指定待测的包目录：

```bash
PI_BACKGROUND_TASKS_TEST_DIR=/path/to/pi-background-tasks npm test
```

`tests/background-task-autopatch.test.ts` 还验证幂等、并发锁、关闭开关、版本与源码不匹配、
无 Git、只读文件，以及两种真实扩展加载顺序下“本次应用、下次启动生效”。
没有 2.6.9 时这些集成测试明确跳过。请确认测试结果不是 skipped，再认为目标版本已验证。
未覆盖 Fusion、delegate、attested 的完整模型执行或存活任务跨重载流程。

## pi-background-tasks 2.6.9：面板关闭按键

文件：`pi-background-tasks-2.6.9-panel-close.patch`。同时修改 `src/ui/background-tasks-manager.ts`
和实际运行的 `dist/src/ui/background-tasks-manager.js`，无需构建。

- 用 `parseKey()` 识别 Kitty / CSI-u / modifyOtherKeys 编码后的 `q`、`x` 及大写按键。
- 保留 `matchesKey()` 对 `Esc` 的兼容处理；列表和详情页均可关闭。
- Ctrl/Alt 组合键不关闭面板；关闭不会停止或重新运行任务。
- 不修改其他操作按键，也不修复高度裁切或被其他组件拦截的输入。

此补丁与目录补丁独立预检和应用，共用 Background task autopatch 设置及
`PI_ENHANCE_BACKGROUND_AUTOPATCH=0` 禁用开关。使用独立锁 `.pi-enhance-panel-close.lock`。
首次应用只改磁盘文件，待当前任务结束后 `/reload` 或重启加载；不自动中断任务。

手动 Apply/Revert 使用上面的相同步骤，将 `patch_file` 改为：

```bash
patch_file="$(pwd)/patches/pi-background-tasks-2.6.9-panel-close.patch"
```

撤销前先禁用 autopatcher，否则下次启动会再次应用。
`tests/background-panel-close-patch.test.ts` 在临时插件副本上验证幂等、并发锁、源码不匹配时不部分修改、
可撤销性，以及 src/dist 在真实 TUI 输入路由下的列表/详情关闭、组合键和 key release 行为。
测试不修改已安装的插件，不替代实际终端键盘协议与焦点检查。

## @gotgenes/pi-subagents 23.4.0：旧通知隔离（实验性）

文件：`gotgenes-pi-subagents-23.4.0-stale-notifications.patch`。仅适用于此包的 **23.4.0**，不是同名的 `pi-subagents` 包。它直接加载 `src/index.ts`，因此无需构建。

- 待发通知绑定该轮的 AbortController（每次 resume 会换一个），不再把上一轮通知解释成新一轮进度或完成。
- 保留进度及完成通知的 `triggerTurn: true`，不合并通知，不改变结果、并发、steer 或权限。
- settled 处理器不再一次性交给 Pi 多个不可撤回的提示；在处理器外，每次最多发送一条，发送前检查父会话是否空闲、结果是否已消费或被等待者认领。
- 下一条仍留在插件中，因此主代理第一轮读取其他结果后，重复完成通知可以被丢弃。已结束子代理的未投递进度仍随其完成结果送达。
- dispose 清除待发通知与定时器；保留原 workspace notice 行为。

只取消被 resume 取代的旧轮通知，**不提供旧轮结果归档功能**。恢复子代理前应先收集旧轮结果；当前轮未消费的结果仍正常通知。已经进入 Pi 队列的旧消息不能由此补丁撤回。

### 启动 autopatcher（默认关闭）

在 `/enhance-patches` 中开启 **Subagent notification autopatch (experimental)**，或在统一配置写入
`"subagentNotificationAutopatchEnabled": true` 后 `/reload`。启动检查 `subagent` 工具及目标插件的已发布 service，
避免把同名工具的其他插件当成目标；仅支持默认 npm 安装目录。

包名/版本必须匹配 23.4.0，反向预检确认未应用后取得 `.pi-enhance-subagent-notifications.lock` 互斥锁，
再次反向检查、正向全文件预检及写权限检查后应用。已应用不重复写；任何不匹配均提示跳过。
成功只修改磁盘，不改变本次已加载的模块；当前任务结束后需再 `/reload` 或重启。不会自动中断任务。

`PI_ENHANCE_SUBAGENT_AUTOPATCH=0` 优先关闭自动应用；菜单和 show 会显示环境覆盖。
关闭开关不会撤销已应用补丁。异常退出的锁只可在确认应用进程已结束后手动移除。

### Apply / Revert

先结束子代理并退出 Pi，在本增强包根目录运行：

```sh
patch_file="$(pwd)/patches/gotgenes-pi-subagents-23.4.0-stale-notifications.patch"
plugin_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/@gotgenes/pi-subagents"
(
  cd "$plugin_dir" || exit 1
  node -e 'const p=require("./package.json"); if(p.name!=="@gotgenes/pi-subagents" || p.version!=="23.4.0") process.exit(1)' || exit 1
  git apply --check "$patch_file" && git apply "$patch_file"
)
```

成功后重启 Pi；不要在任务运行中应用、撤销或 reload。撤销前先关闭通知 autopatcher
（或在后续启动设置 `PI_ENHANCE_SUBAGENT_AUTOPATCH=0`），否则下一次启动会重新应用。撤销同样先退出 Pi：

```sh
(cd "$plugin_dir" && git apply --reverse --check "$patch_file" && git apply --reverse "$patch_file")
```

### 验证与限制

`tests/subagent-notification-patch.test.ts` 在原始安装包的临时副本上应用/撤销补丁，检查已消费结果过滤、跨 resume 隔离、新轮正常唤醒、活跃进度、未消费完成、等待者 claim、workspace notice、父会话忙碌及 dispose。还调用真实 Pi 的 settled 和发送方法，用模型执行替身验证不再一次性积压多条提示。

```sh
node --test tests/subagent-notification-patch.test.ts
# 原始包安装在其他位置时：
PI_SUBAGENTS_TEST_DIR=/path/to/original/package node --test tests/subagent-notification-patch.test.ts
```

`tests/subagent-autopatch.test.ts` 验证版本/包名、源码预检、幂等、并发锁、无 Git、只读文件、显式开启、
目标 service/tool 检测、环境禁用，以及真实增强包加载器在两种加载顺序下的配置接入和只通知一次。
加载顺序测试用 service/tool 替身；不等同于真实目标插件的整套初始化。所有写入仅发生在临时安装副本。

没有目标版本时测试明确 skipped。尚未覆盖真实模型 Goal + Subagent 端到端执行、真实子代理中断及跨重载恢复；补丁应先在非关键任务中试用。通知至少延迟一个 25ms 调度周期；忙碌但尚未收到 agent_start 时也会重新检查。插件升级/重装可能覆盖补丁，不要强制套用到其他版本。

# pi-interactive-shell 0.17.0 cancellation patch

`pi-interactive-shell-0.17.0-abort.patch` 修改 `index.ts`、`overlay-component.ts`、
`headless-monitor.ts` 和 `session-manager.ts`，让工具取消信号结束限流查询或阻塞窗口等待。
查询取消不杀对应进程；完成订阅可以退订，避免等待者和定时器残留。
配合本包的原生浮层关闭包装使用。只支持默认 npm 安装的 0.17.0；启动时默认自动预检应用。

手动 Apply（在 shell 插件安装目录执行，补丁路径替换为本仓库路径）：

```sh
git apply --check /path/to/pi-enhance-patches/patches/pi-interactive-shell-0.17.0-abort.patch
git apply /path/to/pi-enhance-patches/patches/pi-interactive-shell-0.17.0-abort.patch
```

Revert 前先设置 `PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH=0`，避免启动时再次应用：

```sh
git apply --reverse --check /path/to/pi-enhance-patches/patches/pi-interactive-shell-0.17.0-abort.patch
git apply --reverse /path/to/pi-enhance-patches/patches/pi-interactive-shell-0.17.0-abort.patch
```

Apply 或 Revert 后等当前任务结束，再 `/reload` 或重启 Pi。
具体复现和边界见 [`../poc/INTERACTIVE-SHELL-ABORT.md`](../poc/INTERACTIVE-SHELL-ABORT.md)。
