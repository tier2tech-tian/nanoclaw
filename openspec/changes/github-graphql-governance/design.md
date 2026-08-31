## Context

所有 NanoClaw 群当前共用同一个 `gh` OAuth 身份和 5000 点/小时 GraphQL 配额。`gh project item-list/field-list` 为通用展示而设计，会为每个事项展开 `fieldValues(first:100)` 及多层嵌套资源；本地 `jq` 过滤不改变服务端成本。2026-08-31 实测旧链路在 18 分钟内从 4493 降到 1，而直接查询 Project #9 的 54 个事项和 15 个字段只消耗 1 点。

风险入口有两类：容器 Agent 执行的 `kickoff/implement/wrapup`，以及 NanoClaw 主进程每分钟执行的 GitHub Project 自动派工器。前者同时服务 Claude SDK 与 Codex，后者即使无人操作也会持续轮询，因此必须一起治理。

## Goals / Non-Goals

**Goals:**

- 用最小字段 GraphQL 完成现有 Project 读写，不改变业务生命周期。
- 后台轮询在低水位时本地熔断到服务端重置时间，避免持续补刀。
- 把 Agent 可执行的 Project 操作收敛到一份共享治理 Skill。
- 用契约测试锁住危险查询形状和两种运行时同步路径。

**Non-Goals:**

- 不拆分或更换 GitHub 账号，不提高 GitHub 配额。
- 不修改 Project #9 的字段、选项、自动化或历史事项。
- 不重写自动派工状态机、数据库或飞书投递链路。
- 不禁止低成本的 GitHub Issue/PR 常规操作。

## Decisions

### 1. 后台派工直接使用分页 GraphQL

保留 `createGhProjectItemLoader` 入口与返回类型，只把内部命令从 `gh project item-list` 换成 `gh api graphql`。查询每页最多 100 项，仅取 `id`、内容标题/正文/URL，以及通过 `fieldValueByName` 定向读取的 Status 和 Assignees；按 `pageInfo` 手工翻页。

没有采用“继续用 CLI 但调小 limit”，因为 CLI 的每项富字段展开不随输出过滤消失；没有引入 GitHub SDK，因为当前已有可靠的 `gh` 登录态和命令执行边界，引入新依赖没有收益。

### 2. 查询后判低水位，并记住 resetAt

查询把 `rateLimit { cost remaining resetAt }` 放进同一响应，不额外消耗一次探针，并通过 `gh api graphql --include` 保留失败响应自己的 `X-RateLimit-Remaining` 与 `X-RateLimit-Reset`。默认低水位为 100；成功响应体或失败响应头任一观测到 `remaining <= 100`，都抛出可见错误并把 `blockedUntil` 缓存在 loader 闭包。重置前的后续调用在本地直接拒绝，不执行 `gh`；达到重置时间后自动恢复。

不能用 REST `/rate_limit` 补查 GraphQL 失败：2026-08-31 同一身份实测 REST 返回 GraphQL `remaining=5000`，紧接着 GraphQL 响应头返回 `remaining=0`。治理判断只信当前 GraphQL 响应自身的 body/header，避免跨桶或缓存视图造成假放行。

选择 100 而不是更高阈值，是因为治理后的正常 Project 读请求实测成本为 1，100 能在观测后留出人工收口空间，同时不会过早停掉自动派工。该状态是 loader 进程内熔断，不与其他 Agent 共享，因此不承诺全局硬预留；Agent 工作流在每组 Project 操作前执行一次同响应配额门，遇低水位同样停止。阈值作为构造参数保留测试和未来调整能力。

### 3. Agent 操作由单一治理 Skill 承载

新增 `github-project-governance` 纯指令 Skill，定义项目发现、定向查重、字段读取、草稿/Issue 入池、批量字段更新、状态回读和配额门。`kickoff/implement/wrapup` 只描述生命周期并强制调用该 Skill，三处不再复制 GraphQL 模板，也不允许直接出现 `gh project` 子命令。

没有新增跨 Skill 的可执行脚本：Claude SDK 与 Codex 对 `${CLAUDE_SKILL_DIR}` 的解析环境不同，脚本路径会引入新的运行时耦合；统一指令 Skill 已由现有同步机制天然覆盖两端。

### 4. 独立字段写入合并为单次 mutation 文档

同一动作内的 Status、类型、环境等互不依赖字段使用 GraphQL alias 放在一个 mutation 文档中，减少网络往返；必须检查顶层 `errors`，写后一次定向 Item 回读覆盖所有目标字段。若部分成功，只对未达到目标的字段幂等补写。创建草稿或把 Issue 加入项目仍是独立 mutation，因为后续字段写入依赖返回的 Item ID。

### 5. 查询解析 fail closed

响应缺少项目、事项、分页信息或配额快照时直接报错；`hasNextPage=true` 时必须有 `endCursor`，合法终页允许空游标。只有完整翻完所有页面才返回事项列表。保留原有 `parseProjectItems` 作为统一业务对象转换，降低对派工状态机的影响。

## Risks / Trade-offs

- [GitHub GraphQL schema 变化] → 查询字段锁在官方稳定类型，并用响应结构测试与真实 Project E2E 双重验证。
- [共享账号还有未知调用者] → 本改动不能阻止仓库外的高成本查询，但会清除 NanoClaw 已知持续入口，并让每次后台查询成本可观测。
- [低水位时自动派工延迟] → 这是有意保护；窗口重置后自动恢复，错误日志包含项目号和 resetAt。
- [纯指令 Skill 仍可能被模型绕过] → 三段 Skill 写硬禁止，契约测试扫描危险命令；后续发现旁路时只需扩展同一治理入口。

## Migration Plan

1. 先以测试锁死旧命令、分页、熔断和同步行为。
2. 合入后下一轮群会话准备会把新治理 Skill 同步到 Claude SDK/Codex，无需重启共享服务即可覆盖新会话。
3. 主进程代码需随正常 NanoClaw 发布生效；发布前后用同一 Project 执行一次只读查询，记录真实 cost。
4. 回滚只需回退本 PR；没有数据迁移，Project 现有事项不受影响。

## Open Questions

无。

## 测试计划

- P0 纯逻辑：GraphQL 单页/多页、合法终页空游标、异常续页空游标、最小查询形状、成功 body 与失败 header 低水位、错误体携带配额、非法 resetAt 高低水位分流、resetAt 前零远端调用、重置后恢复，约 15 个用例。
- P0 契约：三段 Skill 必须加载治理 Skill、无 `gh project` 或自带 Project GraphQL 旁路，约 5 个用例。
- P1 同步：`prepareGroupSession` 与 `prepareCodexSkills` 均复制治理 Skill，且同步后内容与源文件一致，约 3 个用例。
- P1 回归：自动派工既有状态机和全量测试不变；真实 Project #9 与后台实际项目分别完成只读查询并记录低个位数 `cost`，约 3 个验证。
