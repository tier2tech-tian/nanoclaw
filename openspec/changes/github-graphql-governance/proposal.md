## Why

NanoClaw 的开发工作流和后台自动派工器通过 GitHub CLI 的 Project 富查询共享同一个 5000 点/小时 GraphQL 配额，实测十几分钟即可把整个账号的配额打空并阻断所有群的任务启动与收尾。必须把查询形状和低水位行为收进统一治理层，不能继续靠人工少调用。

## What Changes

- 禁止 `kickoff`、`implement`、`wrapup` 直接调用高成本 `gh project` 子命令，统一改走最小字段的 `gh api graphql` 操作规范。
- 后台自动派工器改为分页读取所需字段，不再展开每个事项的全部字段值和嵌套资源。
- 后台读取加入共享配额低水位熔断：达到保底线后记住 `resetAt`，窗口重置前不再轮询补刀。
- 每次安全查询暴露 `cost / remaining / resetAt` 遥测，错误可见且不把截断结果当完整结果。
- 增加契约测试，锁死危险命令、查询形状、熔断行为以及 Claude SDK/Codex 的同源同步。

## Capabilities

### New Capabilities

- `github-project-quota-governance`: 约束 GitHub Project 的低成本读写、共享配额保护、遥测与多运行时一致生效。

### Modified Capabilities

无。

## Impact

- `src/github-project-dispatcher.ts` 及其测试：替换 Project 读取客户端并增加熔断与遥测。
- `container/skills/github-project-governance/`：新增统一操作规范。
- `container/skills/kickoff/`、`implement/`、`wrapup/`：改为引用统一规范，不再内嵌危险命令。
- `src/container-runner.test.ts`、`src/github-project-workflow-skills.test.ts`：验证两种运行时同步和工作流契约。
- 不改变 GitHub Project 字段、状态机、项目路由、飞书派工消息或数据库结构。
