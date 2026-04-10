## ADDED Requirements

### Requirement: 双路检索
系统 SHALL 对用户查询同时执行 Qdrant cosine 向量检索和 SQLite FTS5/BM25 关键词检索，融合结果返回。

#### Scenario: 正常双路检索
- **WHEN** agent 调用 search_chat(query: "上次讨论的权限方案")
- **THEN** 系统并行执行 Qdrant cosine top-K×3 和 FTS5 BM25 top-K×3，按 chunk_id 去重合并

#### Scenario: Qdrant 不可用时单路降级
- **WHEN** Qdrant 服务不可达
- **THEN** 系统仅使用 FTS5 关键词检索返回结果，记录 warn 日志

### Requirement: 加权融合排序
系统 SHALL 对双路结果按 0.7 * vec_score + 0.3 * bm25_score 加权融合排序。

#### Scenario: 融合排序
- **WHEN** 双路检索各返回一组结果
- **THEN** 系统对两路结果按 chunk_id 对齐，缺失的路补 0 分，按加权公式计算最终分数并排序

### Requirement: 时间衰减
系统 SHALL 对检索结果施加时间衰减，近期对话排名更高。

#### Scenario: 90 天半衰期
- **WHEN** 融合排序完成
- **THEN** 系统对每个结果的分数乘以 e^(-lambda * age_days)，其中 lambda = ln(2)/90，90 天前的结果分数减半

### Requirement: MMR 去重
系统 SHALL 使用 Maximal Marginal Relevance 避免同一话题的多个 chunk 霸占结果。复用现有 `memory/mmr.ts` 的 `mmrRerank()` 函数。

#### Scenario: 相似 chunk 去重
- **WHEN** 排序后 top-K 中存在多个内容高度相似的 chunk（cosine > 0.9）且 Qdrant 可用（有 embedding 数据）
- **THEN** 系统保留分数最高的那个，后续相似 chunk 被降权

#### Scenario: Qdrant 不可用时跳过 MMR
- **WHEN** Qdrant 不可达，仅 FTS5 返回结果（无 embedding 向量）
- **THEN** 系统跳过 MMR 去重，直接按融合分数排序返回

### Requirement: IPC search_chat 任务
系统 SHALL 在宿主进程的 IPC 中注册 search_chat 任务类型，接收容器内 agent 的检索请求。

#### Scenario: IPC 请求响应
- **WHEN** 容器内 agent 写入 search_chat IPC 任务（含 query、options）
- **THEN** 宿主进程执行双路检索，将结果写入 IPC responses 目录

#### Scenario: IPC 超时
- **WHEN** 检索耗时超过 15 秒
- **THEN** 返回超时错误，不阻塞容器进程

### Requirement: search-chat MCP Skill
系统 SHALL 提供 container/skills/search-chat/ skill，容器内 agent 通过该 skill 调用 IPC 检索。

#### Scenario: Skill 调用
- **WHEN** 用户要求搜索历史聊天记录
- **THEN** agent 调用 search_chat tool，传入 query 和可选 options（group、sender、days、limit）

#### Scenario: 返回格式
- **WHEN** 检索完成
- **THEN** 返回数组，每项包含 chunk_text（对话片段）、score（融合分数）、group_name（群名）、sender_names（参与者）、time_range（时间范围）、message_count（消息数）

### Requirement: 过滤参数
系统 SHALL 支持按群、发送人、时间范围、返回数量过滤检索结果。

#### Scenario: 按群过滤
- **WHEN** search_chat(query, { group: "某群名" })
- **THEN** 仅检索该群的聊天记录

#### Scenario: 按时间过滤
- **WHEN** search_chat(query, { days: 7 })
- **THEN** 仅检索最近 7 天的聊天记录

#### Scenario: 默认参数
- **WHEN** 未指定 options
- **THEN** 搜索所有群、不限时间、返回 top-10

### Requirement: 搜索权限
系统 SHALL 根据调用方身份控制搜索范围。所有群共享同一个用户（大杰），默认允许跨群搜索。

#### Scenario: 默认跨群搜索
- **WHEN** 任意群的 agent 调用 search_chat 且未指定 group 参数
- **THEN** 搜索所有群的聊天记录（设计决策：单用户场景下所有群对用户透明）

### Requirement: FTS5 查询方式
系统 SHALL 对 FTS5 trigram 索引使用原始查询文本做 MATCH，不做应用层预分词。

#### Scenario: 中文 trigram 匹配
- **WHEN** 用户查询 "权限体系"（≥ 3 字符）
- **THEN** 系统直接用 "权限体系" 做 FTS5 MATCH（trigram tokenizer 自动处理），不调用 extractKeywords()
- **NOTE** trigram 最小匹配长度为 3 字符，< 3 字符的查询需依赖向量检索兜底
