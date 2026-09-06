# codex-as 模式

`/mode codex-as` 切入新模式，`/mode codex` 切回原模式。两者沿用现有切模式约定：停止旧任务、清除会话绑定，下一条消息开启新模式会话；不删除工作文件。

## 行为

- 运行中的普通补充通过 Codex App Server `turn/steer` 投递，并校验活跃轮次；只在明确完成时发送任务终态。
- 模型 override 消息在当前任务结束后处理，不越过它消费后续消息。
- 共用现有群级 Codex 模型/effort/serviceTier、认证和技能配置。
- 新旧模式独立选择，旧 `codex exec` 不改控制流；首版仅 NanoClaw，未移植 Nine。

## 不确定输入与错误通知

`data/ipc/<group>/input/.codex-as/claimed/` 只存未提交输入，可以恢复；`uncertain/` 存已发出但接受回执尚未确认的输入，禁止自动重发。后者需结合线程历史和用户意图确认是否补发，不能直接批量移回 input。接受回执表示服务端已接收，不保证业务执行成功；执行成功仍以任务终态为准。

失败通知发送失败时保存在 `data/ipc/<group>/codex-as-notices/`，下次该群处理消息时仅补发通知，不重新执行原任务。存储的是用户原文及执行提示，应按群目录原有权限管理。

## 验证记录

基线：64901ce5；本机 Codex：0.153.4。

- 实际生成协议并完成 initialize 握手；无活跃轮次 steer 实测返回 -32600 / no active turn to steer。
- 真实隔离普通任务：返回“接入正常”和用量，证据 `/tmp/codex-as-live-WYPYJG/outputs.json`。
- 真实隔离插话：任务原本等待4秒后回复 OLD，运行中加入更正，经 steer accepted，最终恰好一个 success / NEW；证据 `/tmp/codex-as-steer-live-LQc8Ya/evidence.json`。
- 定向测试106条通过，包含真实 agent-runner 外层跨轮认领、主进程错误回调与通知发送失败、模式切换迟到输出、不同线程/轮次干扰、主动关闭无回执、子进程强制回收。
- 最终全量1766通过、2失败。失败分别为 `src/code-graph-skill.test.ts` 的旧文案断言和 `src/ipc.test.ts` 的旧跨群策略断言；均在未修改主干复现。初次主干还存在 index.test 缺少 IPC_POLL_INTERVAL mock，本次新增宿主测试时已补齐。
- host/agent-runner TypeScript 编译、OpenSpec 严格校验及 diff check 通过。
- 尚未合并、重启共享服务或切换用户群；飞书真实卡片及部署后使用验收待批准部署后执行。App Server 不支持的交互请求会明确拒绝，问题卡使用现有 NanoClaw MCP 工具通道。

## 决策依据

新增模式提供独立试用入口；现有 /mode 已定义切换语义，不引入跨模式无缝迁移。
App Server 在单个 host 任务内保持双向连接，任务结束后关闭，轮间仍沿用线程恢复，避免新增 daemon 和监听端口。
宿主与 runner 都不能把输出进度视为执行成功；发送状态不明时默认保全而非自动重试。

官方协议：https://learn.chatgpt.com/docs/app-server#steer-an-active-turn
