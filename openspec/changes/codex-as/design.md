## Context

基线 64901ce5。现有 /mode 明确清除会话绑定，不需要跨模式无缝接续。Codex CLI 0.153.4 本机生成的协议包含 turn/start、turn/steer 与 expectedTurnId。

## Goals / Non-Goals

目标：新增可单群启用的模式，活跃任务内接收补充，严格收口终态并保全不确定消息。
非目标：跨模式历史迁移、Nine 移植、自动全群切换、改变共享服务部署方式。

## Decisions

1. 新建独立 codex-as-runner；旧 runCodexQuery 不改控制流。初始上下文与模型配置沿用当前 Codex 分支，新模式选择新函数。
2. 每次父任务启动独立 app-server 子进程，stdio JSON-RPC 初始化后 start/resume 线程，再启动一轮。父任务执行期间保持连接并轮询 IPC；自然结束后关闭子进程。codex-as 的初始、轮间和 override 延后 IPC 均使用独立认领结算，不能调用读取即删除的 drainIpcInput；turn/start 回执不明亦隔离保全。无需新增常驻 daemon 或监听端口。
3. 使用本机协议证据，提供结构化 RPC 错误及有界请求等待。响应、事件必须校验类型和 thread/turn 身份。未知服务器请求明确拒绝，不能悬挂等待。
4. 新模式补充使用独立认领目录，认领原子 rename；发起请求前写入 uncertain 状态位置，成功响应才删除。异常保留但禁止现有 inflight 自动恢复扫描读取。尚未提交或明确拒绝允许回队，回队失败保留原文件。
5. 一次仅一个 steer 在途；completed 与回执乱序时暂存 completed，等待投递结算。仅旧协议轮成功且明确因轮次不匹配/无活跃轮次拒绝时可启动后续协议轮，旧回答作为进度呈现，仅最后一轮发 host 任务终态。failed/interrupted 优先收口，未接受补充回队，不允许后续成功覆盖失败。协议轮是 App Server turn，host 任务可含明确拒绝后接续的多个协议轮，终态计数以 host 任务为准。
6. turn/steer 不能改模型参数。含模型 override 的补充留在队列，等当前完成后由既有外层读取并应用。新模式普通消息含上下文后再送；sender 身份不伪造成新工具授权主体。
7. 复用现有 Codex 环境、MCP 配置、模型、进度转换；App Server camelCase 事件转换为现有结构。使用公开 reasoning summary，不展示内部推理；只在 completed 结算，不以任意 agentMessage 当终态。
8. 沿用现有 SIGTERM/SIGKILL 和 /mode 用户行为；mode 命令增加内存运行代次失效标记，旧运行的回调与最终返回不得回写 session 或触发重试。新模式宿主按明确终态判断超时：仅 progress 不得成功。codex-as 禁止通用瞬时错误自动重跑，错误通过可见正文推进已交付游标；未获送达确认的补充保持隔离，下一次启动提示有待确认原文。父 runner 被杀亦由 host 错误收口，不以有进度作为成功。

## Risks / Trade-offs

- 请求已执行但回执丢失：无法承诺 exactly-once；默认停止自动重发，原文隔离保全并明确告知。
- 共享模式判断散落于命令、配额、设置和卡片：集中增加 Codex 家族判定，回归原模式；不能误启用 Anthropic 账号轮换。
- 真实 App Server 与假进程测试有差异：本机协议生成/无模型握手验证 + 可控假进程时序测试 + 真实隔离任务验证；真群测试依赖共享部署，不冒充已完成。
- 问题卡成功会结束本轮：新 runner 仍应传递工具授权及文字终态，避免重演假 success 抢跑。

## Migration Plan

合并和共享重启获批后仅在测试群 /mode codex-as；回滚使用 /mode codex。两者均遵循当前终止任务和清会话绑定方式。

## 测试计划

纯逻辑：模式识别、参数/事件转换、线程和轮次过滤、用量转换。
假子进程：P0 约 10 条覆盖初始化/续接、正常 steer、两次连续补充、回执晚于 completed、明确拒绝、安全回队、不确定保全、退出/超时单终态；P1 约 8 条覆盖 MCP/问题卡、公开思考、模型 override、关闭及格式异常。
回归：旧 codex-runner、模式命令、技能配置、配额、卡片、全量 host/runner 测试与编译。真实隔离任务验证只运行受控无副作用提示，测试日志写入临时目录；共享重启后飞书验收单列待决项。
