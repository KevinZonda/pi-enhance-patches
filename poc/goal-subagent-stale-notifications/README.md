# Goal + Subagent 旧通知最小复现

运行：

```sh
node poc/goal-subagent-stale-notifications/repro.mjs
```

直接加载本机已安装的 `@gotgenes/pi-subagents` 23.4.0 和 Pi 1.1.0，使用真实 `NotificationManager`、`SubagentState`、`AgentSession.sendCustomMessage` 与 `_emitAgentSettled`。模型执行和事件连接使用替身，不调用模型，不启动子代理，不修改插件。

脚本包含四个 assert 检查：

1. 控制组：插件刷新队列前已完成并消费结果，不发送通知。
2. 跨 resume 进度：第一轮的旧进度在第二轮被当成实时进度发送。
3. 跨 resume 完成：第一轮已消费的完成通知变成 `running / No output`。
4. Pi settled 队列：先安排验收提示，再刷新三条进度；验收提示完成并消费结果后，三条旧进度仍分别启动提示执行。

预期输出包含一条 `PASS control`、三条 `REPRO` 和四次提示执行的 JSON 记录。断言失败时退出码非零。

这是投递机制复现，不是完整 Goal + Subagent 的真实模型端到端复现。第 4 项显式构造 settled 期间的事件顺序，不能单凭它确定原会话每条消息的入队时机。

当前导入路径固定为 Kevin 本机安装位置，包括项目的 `node_modules/jiti`；其他机器需修改脚本顶部的绝对路径。
