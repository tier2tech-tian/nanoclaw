---
name: github-project-governance
description: GitHub Projects v2 低成本读写与配额治理。kickoff、implement、wrapup 或后台任务需要查询、绑定、更新项目项时必须使用。
---

# GitHub Projects v2 配额治理

所有项目看板读写都从这里走，Claude SDK 与 Codex 共用这一份 skill。

## 硬规则

1. 禁止 GitHub CLI 的 Project 子命令；它会展开大量嵌套字段，单次操作可能消耗上百点 GraphQL 配额。
2. 项目看板只允许通过 `gh api graphql` 执行本文给出的最小查询和 mutation（变更操作）。其他 skill 不得复制或自行扩写项目 GraphQL。
3. 每个操作簇的第一次查询必须同时读取 `rateLimit { cost remaining resetAt }`，并把三项写进驾驶舱。
4. 一旦观测到 `remaining <= 100`，立即停止本轮及后续项目调用，记录 `resetAt`，在重置前不得轮询或试探。这里是调用方熔断，不承诺替其他进程保住全局 100 点。
5. 禁止批量展开 Item 的全部字段值；读取单个字段只能用 `fieldValueByName`，读取字段定义只能取 `id/name/options`。
6. mutation 必须检查顶层 `errors`；批量写字段后逐项回读，缺哪项只幂等补哪项，禁止把部分成功报成全部成功。

## 统一调用方式

所有命令都使用变量传参，不把动态值拼进 GraphQL 文本。操作前先确认当前登录账号：

```bash
gh api user --jq '{login,id}'
```

### 1. 解析项目和字段

项目编号已知时，分页读取 Project ID、所需字段、选项和配额：

```bash
gh api graphql \
  -f 'query=query($owner:String!,$number:Int!,$first:Int!,$after:String){organization(login:$owner){projectV2(number:$number){id title url fields(first:$first,after:$after){nodes{... on ProjectV2FieldCommon{id name}... on ProjectV2SingleSelectField{id name options{id name}}}pageInfo{hasNextPage endCursor}}}}rateLimit{cost remaining resetAt}}' \
  -F owner=TierIITech -F number=<项目编号> -F first=100
```

只给项目名时，先最小化列项目，再按“完整名称优先、唯一片段次之”解析；0 个或多个命中必须询问：

```bash
gh api graphql \
  -f 'query=query($owner:String!,$first:Int!,$after:String){organization(login:$owner){projectsV2(first:$first,after:$after){nodes{id number title url}pageInfo{hasNextPage endCursor}}}rateLimit{cost remaining resetAt}}' \
  -F owner=TierIITech -F first=100
```

以上两类发现查询都必须按 `pageInfo` 翻到 `hasNextPage=false`；有下一页时追加 `-F after=<endCursor>`。禁止用固定首屏结论判断项目或字段不存在。

### 2. 定向查重和回读 Item

按内容 URL 或规范化标题查重时只拉 `id/title/url`，用 `pageInfo` 翻页；`hasNextPage=true` 时必须带 `endCursor` 继续，合法终页允许游标为空：

```bash
gh api graphql \
  -f 'query=query($owner:String!,$number:Int!,$first:Int!,$after:String){organization(login:$owner){projectV2(number:$number){items(first:$first,after:$after){nodes{id content{... on DraftIssue{id title body}... on Issue{id title url}... on PullRequest{id title url}}}pageInfo{hasNextPage endCursor}}}}rateLimit{cost remaining resetAt}}' \
  -F owner=TierIITech -F number=<项目编号> -F first=100
```

已知 Item ID 时只回读需要的字段：

```bash
gh api graphql \
  -f 'query=query($item:ID!){node(id:$item){... on ProjectV2Item{id content{... on DraftIssue{id title body}... on Issue{id title url state}... on PullRequest{id title url state}}status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}type:fieldValueByName(name:"类型"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}environment:fieldValueByName(name:"环境"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}}}rateLimit{cost remaining resetAt}}' \
  -F item=<Item ID>
```

### 3. 添加正式 Issue 或草稿项

仓库能力用 REST 检查，避免为 `hasIssuesEnabled` 再耗 GraphQL：

```bash
gh api repos/<owner>/<repo> --jq '{has_issues:.has_issues,permissions:.permissions}'
```

正式 Issue 用 REST 创建或复用，再加入项目：

```bash
gh api graphql \
  -f 'mutation=mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}' \
  -F project=<Project ID> -F content=<Issue 节点 ID>
```

仓库明确关闭 Issues 或仓库策略禁止时，创建项目草稿项；网络或鉴权错误不算关闭：

```bash
gh api graphql \
  -f 'mutation=mutation($project:ID!,$title:String!,$body:String!){addProjectV2DraftIssue(input:{projectId:$project,title:$title,body:$body}){projectItem{id content{... on DraftIssue{id}}}}}' \
  -F project=<Project ID> -f title='<标题>' -f body='<摘要>'
```

### 4. 更新一个或多个单选字段

单字段写入：

```bash
gh api graphql \
  -f 'mutation=mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}' \
  -F project=<Project ID> -F item=<Item ID> -F field=<字段 ID> -f option='<选项 ID>'
```

需要同时写状态、类型、环境等多个字段时，可以用 GraphQL alias 合并为一次 mutation，但每个 alias 都必须返回 Item ID。命令完成后检查顶层 `errors`，再用“定向查重和回读 Item”的查询验证每个目标字段；部分成功时只重试缺失字段，保证幂等。

### 5. 更新草稿正文

给草稿项补 PR URL 时，先从 Item 回读得到 DraftIssue 内容 ID，再更新正文：

```bash
gh api graphql \
  -f 'mutation=mutation($draft:ID!,$body:String!){updateProjectV2DraftIssue(input:{draftIssueId:$draft,body:$body}){draftIssue{id body}}}' \
  -F draft=<DraftIssue 内容 ID> -f body='<包含 PR URL 的完整正文>'
```

## 生命周期语义

- kickoff：解析项目、查重、创建或复用 Item，设置待办态和类型，再回读；进入实现时推进到唯一开工态。
- implement：创建 PR 后补充绑定，推进到唯一评审态，再回读；已完成的 Item 禁止倒退。
- wrapup：只有 PR 已合并且验收通过后才推进唯一完成态，再回读；正式 Issue 同时核验关闭状态。
- 状态名必须从目标项目真实 options 中唯一匹配，禁止把某个项目的 ID 硬编码到其他项目。

## 驾驶舱证据

每个操作簇至少记录：项目 URL、Project ID、Item ID、动作、回读后的真实字段值，以及最后一次 `cost / remaining / resetAt`。任何查询不完整、顶层 `errors` 非空、写后回读不一致或低水位熔断，都必须如实记为未完成，不能继续推进生命周期。
