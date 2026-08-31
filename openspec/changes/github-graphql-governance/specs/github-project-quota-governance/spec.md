## ADDED Requirements

### Requirement: Project 读取采用最小字段查询

系统 SHALL 通过 `gh api graphql` 只读取当前动作所需的 Project、事项、状态、负责人和内容字段，MUST NOT 使用会展开全部 `fieldValues` 或嵌套资源的 `gh project item-list`、`field-list` 等富查询。

#### Scenario: 单页项目读取

- **WHEN** 后台自动派工器读取不超过 100 个事项的项目
- **THEN** 系统只发出一次最小字段 GraphQL 查询并返回完整事项

#### Scenario: 多页项目读取

- **WHEN** 项目事项超过单页上限
- **THEN** 系统按 `pageInfo` 逐页读取直到完整；仅当 `hasNextPage=true` 且 `endCursor` 为空时拒绝异常结果，合法终页允许空游标

### Requirement: 共享配额低水位熔断

系统 SHALL 把 100 点作为共享配额低水位；任一受治理查询观测到 `remaining <= 100` 时 MUST 记录服务端 `resetAt` 并停止该调用方后续远端查询，直到窗口重置。系统不承诺跨进程、跨 Agent 精确保留 100 点，但 MUST 禁止已知调用方在观测到低水位后继续补刀。

#### Scenario: 触达低水位

- **WHEN** 一次查询返回 `remaining <= 100` 和有效的 `resetAt`
- **THEN** 本轮不派工，并在 `resetAt` 前拒绝后续轮询且不调用 `gh`

#### Scenario: GraphQL 以非零状态退出

- **WHEN** `gh api graphql` 因配额耗尽非零退出，但同一响应头带有 `remaining` 与 `resetAt`
- **THEN** 系统必须用该 GraphQL 响应头触发熔断，不得改查 REST `/rate_limit` 决定是否继续

#### Scenario: 错误响应体仍携带配额

- **WHEN** GraphQL 响应同时包含顶层 `errors` 和低水位 `data.rateLimit`
- **THEN** 系统先保留该配额快照并触发熔断，再向调用方暴露错误

#### Scenario: 并发调用越过阈值

- **WHEN** 另一个进程或 Agent 在本调用查询期间消耗共享配额
- **THEN** 本调用以服务端返回的最新快照为准触发熔断，不把 100 点描述为全局硬预留

#### Scenario: 窗口重置

- **WHEN** 当前时间达到已记录的 `resetAt`
- **THEN** 下一轮允许重新查询并用新的服务端配额快照更新熔断状态

### Requirement: 查询成本可观测

每次成功的安全 Project 查询 SHALL 暴露 `cost`、`remaining` 和 `resetAt`；外部调用失败、返回结构缺失或配额熔断 MUST 产生可定位的错误，不能静默返回空列表。

#### Scenario: 成功查询回报配额

- **WHEN** 后台查询返回合法事项和 `rateLimit`
- **THEN** 调用方收到包含项目编号与完整配额快照的遥测回调

#### Scenario: 响应不完整

- **WHEN** GraphQL 响应缺少项目、事项列表、分页信息或配额快照
- **THEN** 系统报错并保留下一轮重试，不把异常响应解释为“项目为空”

#### Scenario: 高水位快照的重置时间非法

- **WHEN** 响应仍有充足配额但 `resetAt` 无法解析
- **THEN** 系统报错且下一轮允许重试，不得误设永久熔断

### Requirement: 三段工作流统一走治理规范

`kickoff`、`implement`、`wrapup` SHALL 复用同一份 GitHub Project 配额治理 Skill；Claude SDK 与 Codex SHALL 从同一个 `container/skills` 来源同步该规范，三段工作流 MUST NOT 内嵌 `gh project` 子命令形成旁路。

#### Scenario: Claude SDK 同步

- **WHEN** 群会话目录由 `prepareGroupSession` 准备
- **THEN** GitHub Project 配额治理 Skill 与三段工作流一起同步到该群的 `.claude/skills`

#### Scenario: Codex 同步

- **WHEN** 群进入 Codex 模式并执行 `prepareCodexSkills`
- **THEN** 同一份 GitHub Project 配额治理 Skill 同步到该群的 `.codex-home/skills`，内容与 Claude SDK 侧源文件一致

### Requirement: Project 生命周期行为保持不变

治理改造 SHALL 保留 Issue 优先、仓库关闭 Issues 时使用草稿项、状态只前进不倒退、类型字段写入、PR 关联与完成态回读等现有行为；生命周期阶段 SHALL 映射到目标项目中唯一匹配的真实选项，而不是写死某一个项目的状态名。

#### Scenario: 开发任务全生命周期

- **WHEN** 一个开发任务经历启动、实现、PR 和收尾
- **THEN** 同一个 Project Item 依次进入目标项目的待办池、开工态、评审态和完成态，且每次状态均由定向查询回读确认

#### Scenario: 已处于后续状态

- **WHEN** 工作流重入时 Project Item 已处于评审中或完成
- **THEN** 系统保持当前状态，不把事项降回待办或处理中

### Requirement: 批量字段写入以回读为准

同一动作内的独立字段 MAY 通过 GraphQL alias 合并写入，但系统 MUST 检查顶层 `errors` 并逐字段回读目标值；部分成功时 SHALL 只补写未达到目标的字段，不能把半成功状态记入驾驶舱。

#### Scenario: 批量写入部分成功

- **WHEN** 一个批量 mutation 返回顶层错误，且回读发现部分字段已经更新
- **THEN** 系统保留已成功字段，只对未达到目标的字段执行幂等补写，并在全部回读一致前保持失败状态
