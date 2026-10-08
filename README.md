# pi-enhance-patches

Pi 及第三方扩展的独立运行时增强包，不修改被补丁插件的源码。
首个功能是 `@gotgenes/pi-permission-system` 的临时权限模式。
已验证 Pi 1.1.0、permission-system 40.0.2。

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
不传参数时不安装权限补丁，完全使用原插件行为。
临时模式持续到本次运行结束，包括配置重读；不写回全局或项目配置。
状态栏显示 `yolo/ask/deny (temporary)`。
`--ask` 在没有 UI 或可达父会话时仍按原插件规则拒绝需要审批的请求。
其他安全插件（例如 cc-safety-net）的拦截继续生效。

## 设置与子代理

临时模式期间，`/permission-system` 显示有效 YOLO 值。
保存其他设置会保留原来的持久 YOLO 值；要修改持久 YOLO，请不带临时参数重启 Pi 后设置。
父会话收到的子代理审批转发同样按临时模式处理。
参数不会自动传播到独立子进程或未加载本包的子代理；它们本地允许的操作不会转发给父会话。

## 兼容性

补丁按目标插件组织在 `extensions/<插件名>/` 下。
顶层 `extensions/index.ts` 只负责注册各模块；permission 插件的参数、生命周期与运行时包装均位于 `extensions/pi-permission-system/`。

通过会话 service 接入共享的配置与审批实例，依赖 permission-system 的内部结构。
升级原插件后需要重新验证。
指定参数却找不到兼容实例时，会提示错误并阻止工具调用。
退出及 `/reload` 时恢复被包装的方法；所有权检查避免旧补丁撤销新实例。
补丁仅绕过原来的 ask，不绕过明确 deny。

```bash
npm install
npm run typecheck
npm test
npm run pack:dry-run
```
