# pi-enhance-patches

Pi 及第三方扩展的独立增强包。
图片、权限与问卷使用运行时包装，不修改目标源码；后台任务目录使用启动 autopatcher，
会在满足条件时修改已安装插件的文件，补丁也可手动应用，见 [`patches/README.md`](patches/README.md)。
包含图片粘贴占位标记、临时权限模式、问卷闲置超时、自定义浮层关闭修复、后台任务全局缓存目录与 Compact When Away。
另提供实验性的 `@gotgenes/pi-subagents 23.4.0` 旧通知补丁：隔离跨 resume 通知，
避免 settled 时整批通知进入 Pi 后无法撤回；保留正常自动唤醒。
支持默认关闭的启动 autopatcher，也可手动 Apply/Revert，限制见 [`patches/README.md`](patches/README.md)。
各模块独立启用，第三方插件均可选。
已验证 Pi 1.1.0、permission-system 40.0.2、rpiv-ask-user-question 2.12.0、pi-background-tasks 2.6.9。

## 安装

```bash
pi install git:github.com/KevinZonda/pi-enhance-patches
```

安装后重新启动 Pi，或先 `/reload` 以注册参数。

本地开发可使用 `pi install /absolute/path/to/pi-enhance-patches`。

```bash
pi --yolo  # 原本 ask 的操作自动批准，明确 deny 仍拒绝
pi --ask   # 原本 ask 的操作询问，覆盖全局 YOLO 和自动审批链
pi --deny  # 原本 ask 的操作自动拒绝，allow 和 deny 保持原样

pi --yolo -- "检查这个项目"  # 带初始消息时用 -- 分隔，避免 Pi 将消息当成扩展参数的值
```

三个参数互斥，同时指定会阻止启动。
不传参数且未通过 `/permission` 选择临时模式时，完全使用原插件行为。
临时模式持续到本次运行结束，包括配置重读；不写回全局或项目配置。
状态栏显示 `yolo/ask/deny`。
`--ask` 在没有 UI 或可达父会话时仍按原插件规则拒绝需要审批的请求。
其他安全插件（例如 cc-safety-net）的拦截继续生效。

## 会话内切换权限

```text
/permission          打开模式选择菜单，同时显示当前状态
/permission show     查看当前模式及有效 YOLO 状态
/permission yolo     临时自动批准 ask
/permission ask      临时恢复询问，绕过自动审批链
/permission deny     临时拒绝 ask
/permission default  移除临时覆盖，恢复配置与自动审批链
```

命令切换覆盖本次运行的 CLI 模式，配置重读不会将其改回。
agent 执行过程中也可以切换，包括从 default 切换到临时模式。
切换影响后续的权限判断；已经打开的审批弹窗继续等待用户回答，不会自动作答。
模式与选择均不写入配置文件，明确 deny 始终保留。
退出或 `/reload` 后命令选择不保留；新实例按 CLI 参数或配置重新初始化。

## 统一设置

本包的持久设置集中在 `~/.pi/agent/pi-enhance-patches.json`，
设置 `PI_CODING_AGENT_DIR` 时使用该目录。

```text
/enhance-patches           打开统一设置菜单
/enhance-patches settings  打开统一设置菜单
/enhance-patches show      查看当前设置
```

菜单集中管理 Compact When Away、问卷闲置超时、图片粘贴占位标记和两个 autopatcher。
压缩阈值选择 `count` 或 `ratio` 后，只显示当前模式的阈值；切换模式时保留两边的数值。
选择 **Save and apply** 将所有设置保存到同一个文件，并自动 `/reload`；取消或 Esc 不写入配置。
手动修改文件后执行 `/reload`。

下面是默认配置：

```json
{
  "askUserTimeoutMs": 60000,
  "imagePasteEnabled": true,
  "backgroundTaskAutopatchEnabled": true,
  "subagentNotificationAutopatchEnabled": false,
  "compactWhenAwayEnabled": true,
  "compactWhenAwayThresholdKind": "count",
  "compactWhenAwayThresholdTokens": 128000,
  "compactWhenAwayThresholdRatio": 0.7,
  "compactWhenAwayIdleMinutes": 10
}
```

旧的 `pi-enhance-patches-asks.json` 和 `pi-enhance-patches-compact.json` 仍作为兼容来源读取，
仅补充统一配置中未设置的对应字段；统一配置的值优先，包括 `false` 和 `0`。
保存菜单后，当前设置全部写入统一文件，不再写入旧文件；旧文件保留。
损坏的统一配置会提示并关闭自动超时/压缩，保存时也不会覆盖损坏文件。
旧文件损坏时，对应自动功能也关闭，除非统一配置明确设置了它。

`/permission` 继续用于会话内临时权限切换。原权限插件的持久规则仍由 `/permission-system` 管理。

## 权限设置与子代理

临时模式期间，`/permission-system` 显示有效 YOLO 值。
保存其他设置会保留原来的持久 YOLO 值；要修改持久 YOLO，请不带临时参数重启 Pi 后设置。
父会话收到的子代理审批转发同样按临时模式处理。
参数不会自动传播到独立子进程或未加载本包的子代理；它们本地允许的操作不会转发给父会话。

## 兼容性

补丁按目标插件组织在 `extensions/<插件名>/` 下。
顶层 `extensions/index.ts` 只负责注册各模块；权限模块位于
`extensions/pi-permission-system/`，问卷模块位于 `extensions/rpiv-ask-user-question/`，
图片模块位于 `extensions/pi-image-paste/`，目录 autopatcher 位于 `extensions/pi-background-tasks/`。
通知 autopatcher 位于 `extensions/gotgenes-pi-subagents/`，与目录 autopatcher 复用安装补丁预检。
空闲压缩模块位于 `extensions/compact-when-away/`，使用 Pi 原生压缩接口，无需第三方插件。
原生浮层关闭修复位于 `extensions/pi-custom-overlay/`，无需第三方插件。

通过会话 service 接入共享的配置与审批实例，依赖 permission-system 的内部结构。
升级原插件后需要重新验证。
指定参数却找不到兼容实例时，会提示错误并阻止工具调用。
退出及 `/reload` 时恢复被包装的方法；所有权检查避免旧补丁撤销新实例。
补丁仅绕过原来的 ask，不绕过明确 deny。

## 自定义浮层关闭修复

默认启用，包装 Pi 1.1.0 的 `ctx.ui.custom()` 原生关闭流程。
关闭 overlay 时只移除该窗口自己的句柄，保留其他浮层及其焦点；非 overlay 对话框使用原行为。
退出及 `/reload` 恢复原方法，重复加载和旧实例清理不会撤销新包装。

原流程关闭栈顶浮层：当 shell 上面还有另一个浮层时，可能关错窗口，却清理了 shell 自身，
导致终端画面残留、倒计时冻结、Enter/Ctrl+T/焦点快捷键失效。
本修复覆盖 `pi-interactive-shell` 的新窗口和重新附着窗口，也适用于其他调用原生接口的浮层。
组件尚未挂载就完成时，不移除现有窗口。关闭回调重复执行仍由 Pi 原生逻辑处理。

只做运行时包装，不修改 Pi 或 shell 插件的安装文件。升级 Pi 后需要重新验证。
已卡住的旧浮层需重启会话；修复在重新加载本包后的新窗口生效。
复现、主屏/全屏验证和证据边界见 [`poc/INTERACTIVE-SHELL-STALE-OVERLAY.md`](poc/INTERACTIVE-SHELL-STALE-OVERLAY.md)。

## 图片粘贴占位标记

TUI 中使用 Pi 的图片粘贴快捷键（默认 `Ctrl+V`）：

- 截图或剪贴板中的图片内容保存到系统临时目录，输入框显示 `[Image #1 (708x172)]`。
  括号中是粘贴时的原始像素宽高，不是模型缩放后的尺寸；读取不到尺寸时显示 `[Image #1]`。
  旧的无尺寸标记仍兼容，尺寸文字不参与图片关联。
- macOS Finder 中复制的受支持图片文件也显示标记；非图片文件保留原路径。
- 连续粘贴依次编号；编号在同一会话中不复用，避免历史输入关联到另一张图片。
- 发送时只附上输入中仍存在的完整标记对应的图片；重复标记不会重复附图。
  附件交给 Pi 原生图片处理链路进行转换、缩放和发送，不要求模型再读取路径。
- 删除标记就不发送该图片；撤销删除、历史重发、队列消息均可复用原标记。
- 图片路径和编号作为非模型上下文的会话条目保存，`/reload` 和恢复会话时重建关联。
  文件必须仍存在；原图发生修改时，重发会读取修改后的内容。
- 文件丢失、未知编号或模型不支持图片时，阻止该消息发送并恢复输入，提示重新粘贴或更换模型。

普通文本、纯非图片文件、在 `!`/`!!` shell 模式下粘贴保持 Pi 原行为。
右键粘贴文本、终端自行粘贴/拖入的路径不会转成图片标记；图片快捷键才触发本补丁。
`[Image #数字]` 和 `[Image #数字 (宽x高)]` 在交互输入中是保留的附件语法，不是普通文本。
不要把图片标记放进 shell 命令；shell 模式下直接粘贴文件路径。
RPC 和扩展发送的消息不做标记替换。

补丁包装 Pi 1.1.0 的内部剪贴板方法，退出或重载恢复原方法；不替换自定义编辑器。
剪贴板接口或内部方法不可用时，提示并保留原生粘贴。
升级 Pi 后需重新验证。系统清理临时图片后，历史标记不可重发，需重新粘贴。

## 问卷闲置超时

需要安装原问卷插件：`pi install npm:@juicesharp/rpiv-ask-user-question`。
问卷插件与本包的加载顺序均可。默认闲置 60 秒后自动跳过；在 `/enhance-patches` 设置
Questionnaire idle timeout，菜单以秒为单位，`0` 关闭。
也可在统一配置 `pi-enhance-patches.json` 中设置：

```json
{
  "askUserTimeoutMs": 60000
}
```

表示闲置 60 秒后跳过。`0` 关闭；正数取整并限制为 1000–86400000ms。
未配置默认 60000ms；`0` 或无效值关闭超时，损坏文件关闭超时并在启动时提示。
修改后执行 `/reload`，`/enhance-patches show` 查看配置。

- 计时从问卷组件准备好开始，输入、编辑和切换选项会重新计时。
- 外部编辑器打开、问卷折叠隐藏或被其他浮窗覆盖时暂停计时。
- 超时通过 Pi 原生回调关闭问卷并清理等待状态，不提交未确认的选择或草稿。
- 模型收到明确的“未回答、超时跳过”，不是“用户拒绝”；不会自动选择或批准选项。
- 结构化结果包含 `answers: []`、`cancelled: true`、`timedOut: true`、
  `reason: "idle_timeout"` 和 `timeoutMs`。
- 正常回答和 Esc 取消保留原结果；中断、退出及重载清理计时器和包装。
- 保留原插件弹出时的一次 BEL（`\x07`，即 `\a`）。
- 仅适用于终端 TUI 的 `ask_user_question`，不影响权限审批、RPC/ACP 或 `pi-goal-x` 的问卷。

闲置状态以不超过 250ms 的间隔检查，事件循环忙碌时可能稍晚结束。
问卷模块包装 Pi 的工具注册读取与该工具每次执行的 UI；
关闭回调只移除问卷自己的浮窗。升级 Pi 或问卷插件后需要重新验证。

### 从独立 asks 包迁移

问卷功能已从 `pi-enhance-patches-asks` 合并到本包，原配置文件保持兼容读取；
查看和修改设置请用 `/enhance-patches`。
如果安装过独立包，请先通过 `pi remove` 移除其原安装来源，再安装或更新本包并 `/reload`。
例如独立包使用本地路径安装时：

```bash
pi remove /Users/kevin/Desktop/cc_plugins/pi-enhance-patches-asks
```

避免同时加载独立 asks 包与本包。权限模块无需问卷插件；仅启用问卷超时时也无需权限插件。

## 后台任务 autopatcher

启动时检测已加载的 `bg_run` 和 Pi agent 目录中默认 npm 安装的 `pi-background-tasks`。
仅针对 2.6.9：反向预检确认尚未应用、正向预检通过且文件/目录可写时，
分别自动应用 `patches/pi-background-tasks-2.6.9-global-cache.patch` 与
`patches/pi-background-tasks-2.6.9-panel-close.patch`。
已应用时不重复写入；其他版本、缺少 Git、权限问题或源码不匹配时提示并跳过。
并发启动使用互斥锁，不删除其他进程的锁；异常退出残留锁需确认进程已结束后手动移除。

目录补丁将新任务日志写到 Pi agent 目录的 `cache/background-tasks/`，按项目真实路径及会话/进程隔离。
面板补丁解析终端编码后的 `q` / `x`（含大写），保留 `Esc` 关闭；关闭面板不会停止后台任务。
`Shift + ↓` 仍只负责打开面板，不是开关切换。
首次应用后提示 `/reload` 或重启：本次已加载的插件仍可能使用旧目录，不自动重载或中断任务。
不迁移或删除旧日志，不修改 Fusion 的独立产物目录；升级或重装 2.6.9 后会重新检查并应用。
非默认 npm 安装位置请手动应用。在统一设置中关闭 Background task autopatch 可禁用自动修改。
`PI_ENHANCE_BACKGROUND_AUTOPATCH=0` 仍优先禁用自动修改，菜单和状态会显示该环境变量覆盖。
补丁撤销前先禁用 autopatcher，否则下一次启动会再次应用。
详细预检、Apply 和 Revert 命令见 [`patches/README.md`](patches/README.md)。

## Subagent 旧通知 autopatcher（实验性）

默认关闭。在 `/enhance-patches` 中将 **Subagent notification autopatch (experimental)** 设为 on，
或在统一配置中设置 `"subagentNotificationAutopatchEnabled": true` 后 `/reload`。
仅在目标插件已加载且默认 npm 安装包为 `@gotgenes/pi-subagents 23.4.0` 时尝试应用；
非目标版本、锁占用、源码不匹配、无 Git 或不可写均提示跳过。不是同名的 `pi-subagents` 包。

首次应用只修改磁盘文件，需在当前任务结束后再次 `/reload` 或重启才能加载补丁；
不会自动中断任务或重载。已入 Pi 队列的旧消息不会被撤回。
`PI_ENHANCE_SUBAGENT_AUTOPATCH=0` 优先禁用自动修改；菜单关闭或环境禁用均不会撤销已应用的补丁。
撤销前先关闭 autopatcher，具体命令和通知行为限制见 [`patches/README.md`](patches/README.md)。

## Compact When Away

上下文达到阈值，整轮任务结束后空闲足够时间时自动压缩。默认开启。

```text
/enhance-patches       打开统一设置菜单
/enhance-patches show  查看当前设置
```

菜单可以设置开关、Context threshold kind (`count` / `ratio`)、当前模式的阈值和空闲分钟数。
`count` 默认 **≥128,000 tokens**；`ratio` 默认 **≥70%**，按当前模型的上下文窗口计算。
两种阈值分别保存，切换类型时保留各自数值，只有选中的类型参与触发判断。
默认空闲时间为 **10 分钟**。菜单的比例以百分比输入，例如 `80` 表示 80%；
JSON 中用 `0.8`。时间接受整数分钟 1–1440，token 数接受正整数，ratio 范围为 >0–1。
无效配置值回退默认值，未设置 kind 时使用 `count`。

所有字段写入统一配置 `pi-enhance-patches.json`。也可手动编辑，之后执行 `/reload`：

```json
{
  "compactWhenAwayEnabled": true,
  "compactWhenAwayThresholdKind": "count",
  "compactWhenAwayThresholdTokens": 128000,
  "compactWhenAwayThresholdRatio": 0.7,
  "compactWhenAwayIdleMinutes": 10
}
```

计时从整轮任务完全结束开始，等待重试、后续队列和原生自动压缩处理完毕。
终端输入会重新计时；输入框有草稿、正在执行工具、有待发送消息、弹出交互窗口，
或 Pi 正在生成/压缩时不会触发。工具和交互窗口结束后重新等待完整的空闲时间。
触发时重新读取上下文 token 估算与当前模型窗口；估算未知或低于阈值时跳过。

直接调用原生 `ctx.compact()`，沿用默认摘要逻辑和压缩钩子，显示开始、完成或失败通知。
每段对话最多尝试一次，失败或取消后也不自动重试；新一轮对话结束后重新计时。
手动/原生压缩同样结束本次等待。加载历史、会话切换、分支导航和 `/reload` 不自动开始计时，
退出时清理计时器和输入监听。执行 `!`/`!!` shell 命令后等待新一轮对话再启用计时。
仅 TUI 生效，print、JSON 和 RPC 模式不触发。
“Away”根据终端空闲推断，阅读回复时也可能触发；压缩会产生模型调用费用，摘要可能遗漏细节。

## 开发检查

```bash
npm install
npm run typecheck
npm test
npm run pack:dry-run
```
