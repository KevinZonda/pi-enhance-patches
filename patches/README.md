# 安装文件补丁

这里的补丁会修改安装文件，与图片、权限和问卷的运行时包装不同。
后台任务补丁有启动 autopatcher，也可使用下面的命令手动 Apply/Revert。
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
默认使用 Pi agent 目录中安装的 2.6.9。可以指定待测的原始包目录：

```bash
PI_BACKGROUND_TASKS_TEST_DIR=/path/to/pi-background-tasks npm test
```

`tests/background-task-autopatch.test.ts` 还验证幂等、并发锁、关闭开关、版本与源码不匹配、
无 Git、只读文件，以及两种真实扩展加载顺序下“本次应用、下次启动生效”。
没有 2.6.9 时这些集成测试明确跳过。请确认测试结果不是 skipped，再认为目标版本已验证。
未覆盖 Fusion、delegate、attested 的完整模型执行或存活任务跨重载流程。
