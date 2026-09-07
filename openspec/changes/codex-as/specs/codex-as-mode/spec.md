## ADDED Requirements

### Requirement: 独立模式与既有切换规则
系统 SHALL 支持 codex-as，保留旧 codex 行为，使用现有 /mode 切换规则。

#### Scenario: 切入与切回
- **WHEN** 用户指定 /mode codex-as 或 /mode codex
- **THEN** 保存指定模式、终止旧 runner、清除会话绑定，下一条消息按指定模式启动，工作文件不被删除。

### Requirement: 运行中补充
系统 SHALL 将执行期间到达的普通补充通过 turn/steer 送往同一线程的明确活跃轮次，包含 expectedTurnId。

#### Scenario: 正常插话
- **WHEN** 一轮任务尚未结束且有补充消息
- **THEN** 补充被接受后继续消费当前协议轮次输出，不提前向 host 发 success；当前 host 任务完成时恰好发一次终态。

#### Scenario: 结束与补充竞争
- **WHEN** 已提交的 steer 与 turn/completed 同时在途
- **THEN** 等待该请求结算后再决定终态；明确因无活跃轮次被拒绝的消息才允许进入下一轮，绝不因超时重发。

#### Scenario: 父协议轮失败时拒绝补充
- **WHEN** 父协议轮 failed/interrupted 且 steer 被明确拒绝
- **THEN** host 任务发失败终态，尚未接受的补充回队，不自动开下一轮掩盖失败。

#### Scenario: 切模式后旧输出到达
- **WHEN** 用户切模式后旧运行仍产生输出或结束回调
- **THEN** 旧运行不得回写 session 或触发重试。

### Requirement: 不确定投递保全
系统 SHALL 区分尚未提交、已接受、明确拒绝与结果不明；不得把结果不明视为未执行并自动重发。

#### Scenario: 回执前断连
- **WHEN** 发送 steer 后未收到回执且进程退出或请求超时
- **THEN** 保留原始消息于隔离目录，明确提示无法确认补充是否执行，当前任务只产生一次失败终态，不自动重投该消息。

#### Scenario: 轮间消息启动回执丢失
- **WHEN** 轮间消息已发送 turn/start 但回执丢失
- **THEN** 同样隔离保全原文，host 不得按错误文本自动重试原 prompt。

#### Scenario: 只有进度后超时
- **WHEN** 宿主只收到进度而未收到明确终态，随后强制超时
- **THEN** 返回失败而非成功，保留不确定 IPC 供后续确认。

### Requirement: 输出与既有工具兼容
系统 SHALL 输出现有 ContainerOutput 进度、工具调用、问题卡授权、usage 和终态；只接受本线程本轮事件。

#### Scenario: 正常工具任务
- **WHEN** Codex 产生公开思考、文字、命令或 MCP 工具事件并完成任务
- **THEN** 输出对应进度，问题卡调用按现有授权通道记录，最终回答与用量一次交付。

#### Scenario: 真错误和无终态退出
- **WHEN** turn/completed 状态为 failed/interrupted 或子进程在终态前退出
- **THEN** 输出恰好一个错误终态，不能当成功或永久等待。

### Requirement: 旧模式隔离
系统 SHALL 仅在 codex-as 使用新通信机制，其他模式保留原分发方式。

#### Scenario: 旧 Codex 回归
- **WHEN** 群仍选择 codex
- **THEN** 继续运行 codex exec，沿用原会话、技能和工具行为。
