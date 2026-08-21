## Context

NanoClaw 运行在本机，没有 GitHub 可访问的公网 HTTP 入口；现有内网调试、进度和 OAuth 服务不能安全承担互联网 webhook。GitHub Project V2 webhook 仍是 preview，且仅靠 webhook 也需要补偿漏事件。因此本次用本机 `gh` 登录态定时读取 Project #6/#7，Project 作为任务主账本，NanoClaw 只保存派工防重状态。

现有跨群 delegation 账本要求一个已注册的 source group，并强制目标群“一群一在办”。GitHub Project 不是飞书群，强行伪造 source 会破坏权限模型；自动派工因此走独立的系统消息注入旁路，不修改 Commander 协议。

## Goals / Non-Goals

**Goals:**

- 分配给 `tier2tech-tian` 的 Bug Project #6 Ready 事项自动交给 C3，需求 Project #7 Ready 事项自动交给 4号；其他负责人和未分配事项忽略。
- 持续 Ready 不重复，离开后重新 Ready 可以重派，重启后状态不丢。
- GitHub/群投递失败自动重试，且不影响现有消息和定时任务处理。
- 默认关闭、无新增 npm 依赖、无凭据复制。

**Non-Goals:**

- 不提供公网 webhook 服务。
- 不改变 GitHub Project 状态；目标群完成后的 Done 回写仍由既有 kickoff/wrapup 工作流负责。
- 不把 GitHub Project 事项写入 delegation_tasks，也不占用 Commander 的单群在办槽位。
- 不支持通过标题关键词猜类型；项目 #6/#7 本身就是权威类型边界。

## Decisions

### 1. 使用轮询，不新增 webhook

新增 `github-project-dispatcher.ts`，启动后立即执行一次，再按配置周期运行。通过 `execFile('gh', ['project', 'item-list', ...])` 读取 JSON，设置超时、输出上限和单飞锁。

选择轮询是因为本机没有公网入口，强行部署 webhook relay 会新增服务、密钥和故障点。GitHub Actions 也无法直接把 Project V2 状态可靠推给本机。默认 60 秒的延迟满足派工场景；首轮使用 `--limit 1000`，若 `totalCount` 更大则立即按真实总数补拉完整项目。

### 2. 项目号决定类型，群别名决定目标

配置包含 owner、负责人 GitHub login、Bug/需求项目号、Bug/需求目标别名和轮询周期；默认 `TierIITech`、`tier2tech-tian`、`6/C3`、`7/4号`。每轮先按 Project 顶层 `assignees` 字段进行大小写不敏感的精确过滤，未分配或分配给其他账号的事项既不记录派工状态也不占目标群槽位；随后通过 `getGroupAlias()` 解析当前别名，并校验 JID 存在于 `registeredGroups`，因此群迁移只需改别名，不改代码。

不使用 Issue label 或标题分类，因为 Project 已经完成类型分流，二次猜测只会制造冲突。

### 3. 独立状态表记录 Ready 代次

新增 `github_project_dispatch_state`：复合主键 `(project_number, item_id)`，字段包含 `last_status`、`ready_generation`、`dispatch_status`、`target_jid`、`last_error`、`dispatched_at`、`updated_at`。

纯状态函数根据旧记录和当前状态决定 `observe / dispatch / retry`：首次观察 Ready 或 `last_status != Ready` 时递增代次并派工；持续 Ready 且 sent 时仅 observe；failed/pending 时重试同一代次；非 Ready 只更新状态。投递阶段失败保持 pending，并在下一轮预先占住同一目标，确保 GitHub 返回顺序变化时后项也不能插队。消息 ID 使用 `ipc_github_project_<project>_<item>_<generation>`，既通过非主群受信消息门禁，也为数据库防重提供稳定键。

### 4. 投递复用现有群通道和消息库

dispatcher 只依赖解析群、群忙闲判断、可见通知和消息入库等注入函数。启动层提供真实依赖，测试使用内存替身。

任务先固化目标群读取基线（已有游标直接复用、缺失时先执行现有恢复逻辑、仍为空则写入 Unix epoch），再通过专用 `storeMessageDirectIfAbsent()` 以 `INSERT OR IGNORE` 写入 messages，显式唤醒目标群队列，最后尝试发送可见通知。首次写入时间戳保证严格晚于已固化的读取游标，既避免同毫秒碰撞或本机时钟回退，也避免新群随后从更晚的可见通知恢复游标、跨过仍在排队的任务；合成派工消息同时从全局消息扫描中排除，防止异常的未来群游标污染所有群共享的扫描游标。可见通知失败只告警、不回滚任务；重试相同代次时稳定 ID 不会覆盖首次时间戳，但仍再次唤醒队列，以覆盖“已入库但唤醒前崩溃”的窗口。

同一轮每个目标 JID 最多派一项；持续 Ready 且已 sent 的事项会继续占用该目标路由，直到 Project 状态离开 Ready。除此之外还通过 `GroupQueue.canAcceptNewTask()` 拒绝正在执行回合或定时任务容器的群，只允许非活跃群或 idle-waiting（完成当前回合、等待输入）的群接下一项。

### 5. 生命周期与错误隔离

`main()` 在 channel 连接完成后启动 dispatcher；shutdown 时先停止其定时器，再关闭 Agent 和 channel。消息入库后调用 `GroupQueue.enqueueMessageCheck()` 唤醒目标群；目标群处于 idle-waiting 时关闭 stdin，让当前 runner 退出并立即消费新任务。轮询函数顶层捕获本地状态、别名和队列依赖异常并写结构化日志，不让定时器产生未处理 rejection 或停止后续轮询。模块提供显式 `stop()`，避免测试悬挂计时器。

## Migration Plan

1. 合并代码后保持默认关闭，正常启动会自动创建状态表。
2. 在本机 `.env` 设置 `GITHUB_PROJECT_AUTO_DISPATCH=true` 与 `GITHUB_PROJECT_ASSIGNEE=tier2tech-tian`，确认当前服务用户 `gh auth status` 可读取组织 Project。
3. 校验 C3、4号别名存在且指向已注册群。
4. 重启 NanoClaw，观察首次同步；先以测试事项进入 Ready 做真链路验证。
5. 回滚时关闭环境变量并重启；状态表保留无副作用，代码回滚后不会被读取。

## Risks / Trade-offs

- [Risk] 轮询有最多一个周期的延迟 → 默认 60 秒，启动时立即同步。
- [Risk] `gh` 登录失效导致停派 → 每轮结构化报错并持续重试，日志明确项目和命令阶段。
- [Risk] 项目超过首轮上限导致尾部漏读 → 检查返回 `totalCount` 并按真实总数补拉；补拉期间项目继续增长时完整性校验失败，下轮自动重试，不静默漏读。
- [Risk] 落库后、唤醒或标记 sent 前进程崩溃 → pending 使用同一代次重试，`INSERT OR IGNORE` 保留首次消息并对重复消息 ID 再次显式唤醒队列。
- [Risk] 目标群忙时多个事项混入一个 Agent 回合 → 同一目标只允许一个持续 Ready 的事项占路由，并检查 GroupQueue 忙闲；其他事项保持 failed 等下轮重试。

## Open Questions

无；项目号、状态名和群别名已在真实 GitHub Project 与本机数据库核实。

## 测试计划

### 测试分层

- 纯逻辑零 mock：Project JSON 解析、状态转换、消息格式和正文截断。
- SQLite 定向测试：首次 Ready、持续 Ready、离开/重入、failed 重试、重启持久化。
- 外部依赖 mock：`gh` 成功/失败/超时/截断，群别名缺失，发送/入库失败，单飞锁。
- 真链路 E2E：分别在 #6/#7 创建临时 Project Draft，设置 Ready，确认 C3/4号收到且 Agent 启动；验证同目标第二项不混入当前回合，随后移出 Ready 并清理测试项。

### 优先级

- P0：负责人过滤、正确路由、Ready 幂等、失败重试、默认关闭、主循环错误隔离。
- P1：重入 Ready、超长正文、Draft 链接、轮询重叠、优雅停止。
- P2：极大项目的 CLI 输出体积与轮询耗时监控。

### 预估范围

新增约 20-25 个测试，覆盖 `github-project-dispatcher.ts`、`db.ts`、`config.ts` 和 `index.ts` 的启动接线。
