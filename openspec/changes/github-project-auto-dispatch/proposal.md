## Why

GitHub Project 已成为需求和 Bug 的统一入口，但事项进入 Ready 后仍需人工复制到对应飞书群，容易漏派、重复派和失去状态闭环。现在需要让 NanoClaw 自动识别项目类型并把任务可靠交给对应数字员工。

## What Changes

- 定时读取 TierIITech GitHub Projects 中处于 Ready 且分配给指定 GitHub 账号的事项，默认账号为 `tier2tech-tian`。
- 按项目类型路由：Bug 管理项目 #6 派给 C3，需求迭代项目 #7 派给 4号。
- 将事项标题、正文、链接和项目上下文注入目标飞书群，触发既有 kickoff 工作流。
- 持久化每个事项的最近状态，首次进入 Ready 时派工，保持 Ready 时不重复派，离开后再次进入 Ready 可重新派。
- GitHub 查询或本地投递失败时记录结构化日志并在后续轮询重试，不阻塞 NanoClaw 主消息循环。
- 通过显式配置启用功能和覆盖负责人账号、项目号、目标群别名、轮询周期；默认关闭。

## Capabilities

### New Capabilities

- `github-project-auto-dispatch`: 定义 GitHub Project Ready 事项的识别、类型路由、幂等状态与群消息投递行为。

### Modified Capabilities

无。

## Impact

- 影响 NanoClaw 启动生命周期、GitHub CLI 调用、新增的 SQLite 派工状态和飞书群投递路径。
- 不新增 npm 依赖；复用本机 `gh` 登录态、现有群别名与 Commander 派工机制。
- 默认关闭，对未配置用户和现有飞书消息处理没有行为变化。
