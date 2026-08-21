## ADDED Requirements

### Requirement: Ready 事项按项目类型自动路由

系统启用 GitHub Project 自动派工后，SHALL 定时读取组织的 Bug 项目与需求项目，并只处理分配给指定 GitHub 账号且首次进入 `Ready` 的事项：Bug 派给 C3、需求派给 4号。负责人账号、项目号和目标群别名 SHALL 可配置，默认分别为 `tier2tech-tian`、`#6 → C3`、`#7 → 4号`。

#### Scenario: Bug 进入 Ready
- **WHEN** Bug 项目 #6 的事项状态从非 Ready 变为 Ready
- **THEN** 系统 SHALL 把该事项投递到 C3 对应的已注册飞书群

#### Scenario: 需求进入 Ready
- **WHEN** 需求项目 #7 的事项状态从非 Ready 变为 Ready
- **THEN** 系统 SHALL 把该事项投递到 4号对应的已注册飞书群

#### Scenario: 非 Ready 事项不派工
- **WHEN** 事项状态为 Backlog、In progress、In review、Done 或其他非 Ready 值
- **THEN** 系统 SHALL 只更新观察状态而不向任何群投递消息

#### Scenario: 非本人事项不派工
- **WHEN** #6 或 #7 的 Ready 事项未分配负责人，或负责人列表不包含配置账号
- **THEN** 系统 SHALL 忽略该事项且不占用目标群派工槽位

#### Scenario: 本人事项大小写不敏感
- **WHEN** Ready 事项负责人包含与配置账号仅大小写不同的 GitHub login
- **THEN** 系统 SHALL 仍识别为同一账号并正常派工

#### Scenario: 负责人配置缺失时安全关闭
- **WHEN** 启用自动派工但负责人账号为空
- **THEN** 系统 SHALL 拒绝本轮派工并记录错误，SHALL NOT 退化为处理全部事项

#### Scenario: 取消分配期间仍跟踪旧事项
- **GIVEN** 事项曾分配给配置账号且已确认 sent
- **WHEN** 负责人被移除或改为其他账号，且事项状态继续变化
- **THEN** 系统 SHALL 更新该事项的非本人观察状态，但 SHALL NOT 派工或占用目标群槽位
- **AND** 事项随后重新分配给配置账号并处于 Ready 时 SHALL 生成新的 Ready 代次

#### Scenario: 未完成投递取消分配后保持原代次
- **GIVEN** 事项处于 pending 或 failed，尚未确认投递成功
- **WHEN** 事项取消本人分配后又重新分配给本人
- **THEN** 系统 SHALL 使用原 Ready 代次和稳定消息 ID 重试，SHALL NOT 创建第二条任务消息

### Requirement: 派工消息提供可执行上下文

系统 SHALL 在派工消息中包含事项类型、标题、正文摘要、GitHub 链接和明确的 kickoff 指令，使目标群可以直接进入既有任务工作流。正文 SHALL 设置长度上限，防止超长 Issue 挤占会话上下文。

#### Scenario: Issue 事项派工
- **WHEN** Ready 事项关联 GitHub Issue
- **THEN** 派工消息 SHALL 包含 Issue 标题、正文摘要、Issue URL、来源项目和“执行 kickoff”的指令

#### Scenario: Draft 事项派工
- **WHEN** Ready 事项是没有独立 URL 的 Project Draft
- **THEN** 派工消息 SHALL 使用项目 URL 作为追溯链接，并仍包含标题和正文摘要

### Requirement: Ready 状态转换幂等

系统 SHALL 持久化每个 Project Item 的最近状态和 Ready 代次。事项持续保持 Ready 时 SHALL NOT 重复派工；事项离开 Ready 后再次进入 Ready 时 SHALL 生成新代次并再次派工。

#### Scenario: 连续轮询同一 Ready 事项
- **WHEN** 多次轮询都观察到同一事项保持 Ready
- **THEN** 系统 SHALL 只产生一次目标群任务消息

#### Scenario: 事项再次进入 Ready
- **WHEN** 已派工事项从 Ready 离开后又重新进入 Ready
- **THEN** 系统 SHALL 以新的 Ready 代次再次派工

#### Scenario: 进程重启后继续防重
- **WHEN** NanoClaw 在事项已派工后重启并再次读到该事项仍为 Ready
- **THEN** 系统 SHALL 读取持久化状态且 SHALL NOT 重复派工

#### Scenario: pending 状态崩溃恢复
- **WHEN** 进程在消息落库后、派工状态标记 sent 前崩溃
- **THEN** 下轮 SHALL 以同一代次和稳定 `ipc_` 消息 ID 重试，消息表 SHALL 保留首次内容与时间戳、目标群队列 SHALL 被再次显式唤醒且 Agent SHALL NOT 重复消费

#### Scenario: 派工消息不会被读取游标跳过
- **GIVEN** 目标群读取游标缺失，或当前游标等于或晚于本机当前时间
- **WHEN** 系统首次持久化派工消息
- **THEN** 系统 SHALL 先固化目标群读取基线，且消息时间戳 SHALL 严格晚于该基线
- **AND** 后续可见通知 SHALL NOT 使游标恢复逻辑跨过尚未消费的派工消息
- **AND** 合成派工消息 SHALL NOT 推进跨群共享的全局消息扫描游标

### Requirement: 同一目标群逐事项派工

同一目标群 SHALL 同时最多保留一个仍处于 Ready 的已派事项。目标群正在执行 Agent 回合时 SHALL NOT 接收新事项；前一事项离开 Ready 且目标群空闲或等待输入后，下一 Ready 事项 SHALL 自动重试。

#### Scenario: 同一群有两个 Ready 事项
- **WHEN** 同轮发现两个都路由到 C3 的 Ready 事项
- **THEN** 系统 SHALL 只派第一项，并把第二项保持为可重试失败状态

#### Scenario: 首项投递失败后项目顺序变化
- **WHEN** 首项投递失败保持 pending，且下一轮 GitHub 把第二项返回在首项之前
- **THEN** 系统 SHALL 仍优先重试原首项且 SHALL NOT 让第二项插队

#### Scenario: 前一事项开始处理
- **WHEN** 前一事项从 Ready 变为 In progress 且目标群已经空闲或等待输入
- **THEN** 系统 SHALL 在后续轮询派发下一 Ready 事项

### Requirement: 外部失败不影响消息主循环

GitHub 查询、目标群解析或群消息投递失败时，系统 SHALL 记录结构化错误并保留可重试状态，后续轮询 SHALL 自动重试；失败 SHALL NOT 阻塞或终止 NanoClaw 主消息循环。同一时刻 SHALL 最多运行一个轮询批次。

#### Scenario: 本地依赖在轮询顶层抛错
- **WHEN** 状态存储、别名解析或队列检查在单轮执行中抛出未被事项级边界捕获的异常
- **THEN** 系统 SHALL 记录 `stage=cycle` 的结构化错误、释放单飞锁，并允许下一轮继续执行

#### Scenario: GitHub CLI 查询失败
- **WHEN** `gh` 未登录、网络失败、超时或返回非法 JSON
- **THEN** 系统 SHALL 记录项目号和错误原因，结束本轮并在下轮重试

#### Scenario: 目标群别名不存在
- **WHEN** C3 或 4号别名无法解析到已注册群
- **THEN** 系统 SHALL 不落成功状态、记录明确错误并在别名修复后的下一轮重试

#### Scenario: 单个项目查询失败
- **WHEN** Bug 项目查询失败但需求项目查询成功
- **THEN** 系统 SHALL 仅重试 Bug 项目，需求项目的正常派工 SHALL NOT 被阻断

#### Scenario: 上一轮尚未完成
- **WHEN** 轮询定时器再次触发而上一批仍在运行
- **THEN** 系统 SHALL 跳过重叠批次且 SHALL NOT 并发查询或重复投递

### Requirement: 功能显式启用且凭据不落库

自动派工 SHALL 默认关闭，仅在显式配置后启动。系统 SHALL 复用当前运行用户的 GitHub CLI 登录态，SHALL NOT 将 GitHub Token 写入代码、日志或 SQLite。

#### Scenario: 未启用功能
- **WHEN** 自动派工配置未设置为 true
- **THEN** NanoClaw SHALL NOT 启动 GitHub Project 轮询器

#### Scenario: 启用功能
- **WHEN** 自动派工配置为 true 且 `gh` 登录态具备读取 Project 权限
- **THEN** 系统 SHALL 启动轮询器并立即执行首次同步
