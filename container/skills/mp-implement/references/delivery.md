# NanoClaw协作交付约定

任务延续kickoff建立的驾驶舱；尚未建立时，按个人资产驾驶舱目录README补建，再开工作树。记录验收范围、关键决定、推翻、里程碑和验证证据，不调用已废弃task-ledger工具。

修改版本库前核对驾驶舱的github_tracking_kind、github_project_url、github_project_number、github_project_id及github_project_item_id；issue类型还需要github_issue_url。缺少绑定时按 [kickoff](../../kickoff/SKILL.md) 补齐。

涉及GitHub Projects读写时执行 [github-project-governance](../../github-project-governance/SKILL.md)，包括开工态、配额、写后回读与PR关联，不能以预期状态冒充回读结果。

按改动模块查团队Wiki中的真实业务契约；提供给审查者固定提交、需求、相关不变量和验证证据。不要把旧文档当成当前实现。

采用项目现有结构化日志，保留关键状态、失败和耗时；凭据、个人数据与完整消息正文按项目脱敏要求处理。

提交前查既有PR是否已合并，已合并则从最新目标分支建立新分支和PR。只提交自己的改动。

PR正文中issue类型使用Closes加完整Issue URL；draft类型使用Tracks加项目URL，并在草稿中补PR链接。按治理技能回读项目状态；若无匹配评审态则如实记录，不编造也不把已完成项倒退。

交付区分已实现、已验证、待合并和已部署。保留未验证项与红灯待决策项，继续执行不依赖它们的工作；用户批准合并后按各仓默认目标分支及merge commit规则操作。
