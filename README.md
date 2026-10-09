# pi-enhance-patches

Pi 及第三方扩展的独立运行时增强包，不修改被补丁插件的源码。
包含 Pi 的图片粘贴占位标记、`@gotgenes/pi-permission-system` 的临时权限模式与
`@juicesharp/rpiv-ask-user-question` 的问卷闲置超时。
三个模块独立启用，两个目标插件都是可选依赖。
已验证 Pi 1.1.0、permission-system 40.0.2、rpiv-ask-user-question 2.12.0。

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

## 设置与子代理

临时模式期间，`/permission-system` 显示有效 YOLO 值。
保存其他设置会保留原来的持久 YOLO 值；要修改持久 YOLO，请不带临时参数重启 Pi 后设置。
父会话收到的子代理审批转发同样按临时模式处理。
参数不会自动传播到独立子进程或未加载本包的子代理；它们本地允许的操作不会转发给父会话。

## 兼容性

补丁按目标插件组织在 `extensions/<插件名>/` 下。
顶层 `extensions/index.ts` 只负责注册各模块；权限模块位于
`extensions/pi-permission-system/`，问卷模块位于 `extensions/rpiv-ask-user-question/`，
图片模块位于 `extensions/pi-image-paste/`。

通过会话 service 接入共享的配置与审批实例，依赖 permission-system 的内部结构。
升级原插件后需要重新验证。
指定参数却找不到兼容实例时，会提示错误并阻止工具调用。
退出及 `/reload` 时恢复被包装的方法；所有权检查避免旧补丁撤销新实例。
补丁仅绕过原来的 ask，不绕过明确 deny。

## 图片粘贴占位标记

TUI 中使用 Pi 的图片粘贴快捷键（默认 `Ctrl+V`）：

- 截图或剪贴板中的图片内容保存到系统临时目录，输入框显示 `[Image #1]`。
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
`[Image #数字]` 在交互输入中是保留的附件语法，不是普通文本。
不要把图片标记放进 shell 命令；shell 模式下直接粘贴文件路径。
RPC 和扩展发送的消息不做标记替换。

补丁包装 Pi 1.1.0 的内部剪贴板方法，退出或重载恢复原方法；不替换自定义编辑器。
剪贴板接口或内部方法不可用时，提示并保留原生粘贴。
升级 Pi 后需重新验证。系统清理临时图片后，历史标记不可重发，需重新粘贴。

## 问卷闲置超时

需要安装原问卷插件：`pi install npm:@juicesharp/rpiv-ask-user-question`。
问卷插件与本包的加载顺序均可。默认关闭自动跳过；创建
`~/.pi/agent/pi-enhance-patches-asks.json`：

```json
{
  "askUserTimeoutMs": 60000
}
```

表示闲置 60 秒后跳过。`0` 关闭；正数取整并限制为 1000–86400000ms。
未配置或无效值关闭超时；损坏文件关闭超时并在启动时提示。
设置 `PI_CODING_AGENT_DIR` 时从该目录读取配置。
修改后执行 `/reload`，`/askpatches` 查看配置。

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

问卷功能已从 `pi-enhance-patches-asks` 合并到本包，原配置文件和 `/askpatches` 保持兼容。
如果安装过独立包，请先通过 `pi remove` 移除其原安装来源，再安装或更新本包并 `/reload`。
例如独立包使用本地路径安装时：

```bash
pi remove /Users/kevin/Desktop/cc_plugins/pi-enhance-patches-asks
```

避免同时加载独立 asks 包与本包。权限模块无需问卷插件；仅启用问卷超时时也无需权限插件。

## 开发检查

```bash
npm install
npm run typecheck
npm test
npm run pack:dry-run
```
