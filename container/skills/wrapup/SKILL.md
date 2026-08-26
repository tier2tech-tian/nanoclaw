---
name: wrapup
description: 任务收尾工作流。回顾任务全过程，总结踩坑记录和未解决问题，形成文档存入 Wiki。触发词：wrapup、收尾、总结任务、任务总结、复盘。
---

# 任务收尾工作流

任务完成后的复盘与知识沉淀。

## 执行步骤

### Step 0: 交付完成门禁

先读本任务驾驶舱。若存在 `github_project_item_id`，必须同时满足以下条件才能继续收尾：

1. PR 已合并，并记录 merge commit 或合并后的 SHA。
2. kickoff 约定的验收已通过；要求 E2E 的任务必须有 E2E 证据，其他任务至少有对应测试或人工验收证据。
3. 跟踪类型、项目 URL、项目编号、Project ID 和 Item ID 齐全；跟踪类型为 issue 时 Issue URL 也必须齐全。

任一条件不满足就停止收尾，明确告诉用户缺什么；禁止先改完成态再补证据。没有 GitHub 项目绑定的非开发任务按原流程继续。

### Step 0.5: 关闭 GitHub 跟踪项（如适用）

驾驶舱存在 `github_project_item_id` 时，在生成 Wiki、归档 OpenSpec 和标记群完成前执行：

1. `github_tracking_kind: issue` 时检查 `github_issue_url` 状态：PR 的 `Closes <完整 Issue URL>` 已自动关闭就只核验，仍为 open 才执行 `gh issue close <Issue 编号> --repo <owner/repo> --reason completed`；`github_tracking_kind: draft` 的草稿项不执行 Issue 关闭命令。
2. 回读当前状态；已经是 `Done` / `完成` 就幂等跳过。否则用 `gh project field-list <项目编号> --owner TierIITech --format json` 获取 Status 字段与真实 option ID，再执行 `gh project item-edit --id <Item ID> --project-id <Project ID> --field-id <Status 字段 ID> --single-select-option-id <完成态选项 ID>` 推进完成态：#9 使用 `完成`，#5 使用 `完成`。未来专项只接受 `Done` / `完成` 的唯一精确匹配，找不到或不唯一就询问，禁止猜测。
3. 回读项目 Item，确认状态为 `Done` / `完成`；issue 跟踪还要确认 Issue 已关闭。把 `github_project_status` 和关闭证据写回驾驶舱。

**Gate**：项目 Item 已完成 + issue 跟踪的 Issue 已关闭 + 驾驶舱证据已落盘。项目自动化只能加速，不能代替这次回读验收。

**📋 日志**：
```
📋 [GitHub 项目收口] 状态=✅
  - Issue: closed / draft n/a
  - Project item: Done / 完成
  - Evidence: <API 回读摘要>
```

### Step 1: 记录目标完成群名

1. 获取当前群名（即最近一次 `rename_chat` 设置的名称）
2. 如果群名已有"(完成)"前缀则记录为已完成
3. 否则记下目标群名 `(完成)任务名`，暂不改名；必须先完成 Step 0.5 的外部跟踪项收口，避免项目更新失败但群名已经显示完成

### Step 2: 回顾全过程

**优先从驾驶舱文件提取**（`/Users/dajay/个人资产/驾驶舱/` 本任务的 md，一手过程记录），对话历史和 todo 只做补充：

- **做了什么**：任务的核心产出
- **关键决策**：过程中做了哪些重要选择，为什么这么选
- **踩坑记录**：遇到了什么问题，怎么解决的（或为什么没解决）
- **反复纠结的点**：哪些地方来回改了多次，最终结论是什么
- **未解决的问题**：遗留了什么，为什么没解决，后续建议

### Step 3: 形成文档

按以下模板生成复盘文档：

```markdown
# [任务名] 复盘

## 概述
一句话说明任务目标和结果。

## 关键决策
| 决策点 | 选择 | 理由 |
|--------|------|------|
| ... | ... | ... |

## 踩坑记录
### 坑 1: [标题]
- **现象**：...
- **根因**：...
- **解法**：...

### 坑 2: [标题]
...

## 未解决问题
### [问题标题]
- **现状**：...
- **为什么没解决**：...
- **后续建议**：...

## 沉淀建议
从本次经验中可以提炼的通用知识或规则，值得写入 Wiki 供后续任务参考。
```

### Step 4: 存入团队知识库（team_wiki）

**写入目标是团队库 `../../global/team_wiki/`，不是个人库 `wiki/`。** 这一点关键：线上飞书对话的向量化召回（`src/memory/inject.ts`）只读 `team_wiki/index.md` + `team_wiki/private/index.md`，写进个人 `wiki/` 的内容召回不到。

1. 使用 `/wiki` skill 的 ingest 流程将文档存入 **team_wiki**
2. **判断进共享层还是 private**（两步判断，按优先级执行）：
   - **Step A: 先判是否影响 Nine 用户体验**——直接或间接影响 Nine 平台功能的知识（包括底层组件如 GitNexus/eval-server/sandbox-api/agent-runner 等）→ **进共享层 `team_wiki/`**，不管内容是否含 open_id/chat_id/IP/端口/容器名/测试账号等开发常规信息（这些不算涉敏）
   - **Step B: 与 Nine 无关的纯个人知识** → `team_wiki/private/`（NanoClaw 自身机制研究 / Wall-E / Claude Code 研究等）
   - **唯一例外：含真实凭据（密码、API Key/Secret、证书私钥、OAuth token）的内容必须进 private**，不管项目归属
3. 分类标签：`复盘`、`[项目名]`、`[技术领域]`
4. 遵循"**综合进已有页的对应小节并回收旧态**"原则（详见 `team_wiki/CONTRIBUTING.md`）：新知识融进对应小节、更新顶部状态、回收被取代的旧描述、禁页内行号引用；不要无脑追加带日期的新章节或新建孤立碎片
5. 更新对应的 `index.md`（共享进 `team_wiki/index.md`，私有进 `team_wiki/private/index.md`，两本索引互不引用）
6. **三处验证落盘后 commit + push**（页 + index + log 用 `grep`/`wc` 确认真在，再推）：
   ```bash
   cd ../../global/team_wiki && git add <页+index> && git commit -m "docs(wiki): <一句话>" && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy git push origin main
   ```
   `private/` 被 gitignore 隔离不进 push；push 报远端有新提交先 `git pull --ff-only` 再推。详见 `/wiki` skill INSTRUCTIONS「Git 同步」。

### Step 5: 归档 OpenSpec（如适用）

如果本次任务走了 OpenSpec 流程：
1. `openspec status --change <name>` 确认任务完成度
2. `openspec archive <change-name>` 归档

### Step 5.4: 标记群完成

Step 0.5 Gate 通过后，若当前群名还没有 `(完成)` 前缀，调用 `rename_chat` 将群名改为 `(完成)任务名`。改名失败则不归档驾驶舱，先修复或如实汇报。

### Step 5.5: 归档驾驶舱（如适用）

> task-ledger 账本已废弃（2026-08-06），不再调 task_* 工具。

如果本次任务有驾驶舱文件（`/Users/dajay/个人资产/驾驶舱/`）：
1. 补齐最后一条事件流水（收尾结论 + 验收结果）
2. 刷新"当前状态"为完成态，文件名前加 `(完成)` 归档
3. **Step 3 的复盘文档优先从驾驶舱生成**（一手过程记录），对话历史只做补充——复盘质量不再受上下文压缩影响

**📋 日志**：
```
📋 [驾驶舱归档] (完成)YYYY-MM-DD-任务名.md
```

### Step 6: 汇报前先过 Step 7/8

（编号保留兼容旧引用，实际执行顺序：先 Step 7、Step 8，最后 Step 9 汇报。）

### Step 7: 沉淀原子块

问一句：**这次做的事里，有没有输入输出清晰、下次可以独立复用的模块？**（脚本、查询套路、命令序列、文档模板……）

有就抽出来存 `$NANOCLAW_PERSONAL_DIR/原子块/`（即 `/Users/dajay/个人资产/原子块/`），一块一文件，写明：用途、输入、输出、验收标准、来源任务。

**复利三铁律**（不满足就不要写，写了也是垃圾）：
1. 压缩到通用层——记"这类问题怎么解"，不记"这次哪一步怎么写"
2. 成功经验记成**动作轨迹**（当时沿什么序列做成的），不写步骤模板
3. 必须指向行动——这条沉淀会改变下一次的做法吗？答不上来就删

配套：造了机制/脚本要当场跑一遍，不跑等于没造；泛化结论验证前只能叫假说。

### Step 8: 记 want-to-do

往 `$NANOCLAW_PERSONAL_DIR/want-to-do.md`（即 `/Users/dajay/个人资产/want-to-do.md`）的"待办"追加本次任务留下的四类条目（没有就跳过，不硬凑）：
- **好奇的种子**：过程中冒出来但没时间验证的想法
- **新工具新方法**：看到但没用上的
- **系统摩擦**：哪里反复卡、反复绕（这是基建改进信号）
- **妥协性验收项**：勉强收了的，必须带触发条件（"什么时候回头看它"）

### Step 9: 汇报（含收兵判定）

向用户简要汇报：
- **收兵判定（第一行）**：对照 kickoff 验收标准——达到了就明说"这仗赢了，建议收兵"；"还能再完善"的项不当场加戏，一律写进 want-to-do 带触发条件
- 复盘文档已生成并存入 Wiki
- 列出沉淀的关键知识点（不超过 3 条）
- 本次沉淀的原子块 / want-to-do 条目（没有就说没有）
- 列出遗留问题（如有）

## 注意事项

- 如果对话太长导致早期上下文被压缩，优先从 todo 记录和 git diff 中恢复信息
- 不要编造没发生过的问题，只记录真实遇到的
- 未解决的问题要诚实说明原因，不要硬编一个"解决方案"
