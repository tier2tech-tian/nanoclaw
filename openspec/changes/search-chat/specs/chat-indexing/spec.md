## ADDED Requirements

### Requirement: Bot 回复持久化
系统 SHALL 在 agent 回复完成后将 bot 回复存入 messages.db 的 messages 表，标记 `is_bot_message=1`。

#### Scenario: Agent 回复正常入库
- **WHEN** agent 完成一轮回复（文本内容非空）
- **THEN** 系统调用 `storeMessage` 存入 messages 表，`is_bot_message=1`，`sender` 为 agent 标识

#### Scenario: 入库失败不阻塞主流程
- **WHEN** `storeMessage` 抛出异常（如磁盘满）
- **THEN** 系统捕获异常并记录 warn 日志，消息收发流程不受影响

### Requirement: 消息分块
系统 SHALL 在 bot 回复入库后触发分块（chunk），每个 chunk 包含一轮用户问题 + agent 回复。chunk id 使用确定性哈希 `sha256(group_folder + chat_jid + sorted(message_ids))` 的前 32 位，确保同一对话片段无论何时索引都产生相同 id。

#### Scenario: 正常分块
- **WHEN** bot 回复入库完成（storeMessage is_bot_message=1 成功）
- **THEN** 系统将该轮对话（对应的用户消息 + 此 bot 回复）合并为一个 chunk，chunk_text 包含双方内容，记录 chat_jid、group_folder（从 registered_groups 通过 chat_jid 查找 folder）、sender_names、start_time、end_time、关联 message_ids

#### Scenario: 超长对话截断
- **WHEN** 单个 chunk 超过 500 token
- **THEN** 系统在 500 token 处截断，保留 100 token 重叠到下一个 chunk

#### Scenario: 噪声过滤
- **WHEN** 消息内容包含 tool_result 大段输出或 internal 标签内容
- **THEN** tool_use 只保留工具名，tool_result 丢弃，internal 内容丢弃

### Requirement: Qdrant 向量索引
系统 SHALL 为每个 chunk 生成 embedding 并 upsert 到 Qdrant 的 chat_chunks collection。

#### Scenario: 正常索引
- **WHEN** 新 chunk 生成
- **THEN** 系统调用 DashScope text-embedding-v4 生成 1024 维向量，upsert 到 Qdrant，payload 包含 chat_jid、group_folder、sender_names、start_time、chunk_text

#### Scenario: Qdrant 不可用时降级
- **WHEN** Qdrant 服务不可达（连接超时或 health check 失败）
- **THEN** 系统跳过向量索引，仅写入 FTS5，记录 warn 日志，不影响消息处理

#### Scenario: Embedding API 失败时降级
- **WHEN** DashScope embedding 调用失败（超时/5xx/rate limit）
- **THEN** 系统将 chunk 标记为 qdrant_indexed=0，仅写入 FTS5

#### Scenario: 启动时重试未索引的 chunk
- **WHEN** 系统启动且 CHAT_INDEX_ENABLED=true
- **THEN** 系统扫描 qdrant_indexed=0 的 chunk（限 100 条），重新生成 embedding 并 upsert 到 Qdrant，成功后标记 qdrant_indexed=1

### Requirement: FTS5 关键词索引
系统 SHALL 为每个 chunk 写入 SQLite chat_chunks_fts 虚拟表，支持 BM25 排序。

#### Scenario: 正常写入 FTS5
- **WHEN** 新 chunk 生成
- **THEN** 系统将 chunk_text 插入 chat_chunks 表和 chat_chunks_fts 虚拟表

#### Scenario: FTS5 使用 trigram tokenizer
- **WHEN** 查询包含中文关键词（≥ 3 字符）
- **THEN** FTS5 使用 trigram 分词器，能匹配 3 字符及以上的中文子串（已知限制：< 3 字符无法匹配）

### Requirement: 异步防抖索引
系统 SHALL 使用防抖机制批量处理索引，避免每条消息立即触发 embedding。

#### Scenario: 防抖合并
- **WHEN** 5 秒内（可配置 CHAT_INDEX_DEBOUNCE_MS）连续收到多条消息
- **THEN** 系统合并为一次批量索引操作

#### Scenario: 索引不阻塞消息循环
- **WHEN** 索引管道正在处理
- **THEN** 消息循环的收发不受影响（异步执行）

### Requirement: 历史回填
系统 SHALL 提供独立脚本从 JSONL session 文件导入存量聊天记录。

#### Scenario: 回填全量 JSONL
- **WHEN** 运行 scripts/backfill-chat-index.ts
- **THEN** 脚本遍历所有群的 .claude/projects/ 下 *.jsonl 文件，提取 user/assistant 消息，按时间排序分块，生成 embedding，写入 Qdrant + FTS5

#### Scenario: 回填过滤噪声
- **WHEN** JSONL 中包含 type: progress 或大段 tool_result
- **THEN** 脚本跳过 progress 事件，tool_use 只保留工具名和摘要

#### Scenario: 回填幂等
- **WHEN** 重复运行回填脚本
- **THEN** 已存在的 chunk（按 id 判断）跳过，不重复写入

### Requirement: 开关控制
系统 SHALL 通过 CHAT_INDEX_ENABLED 环境变量控制索引功能开关。

#### Scenario: 默认关闭
- **WHEN** 未设置 CHAT_INDEX_ENABLED 或设为 false
- **THEN** 索引管道不启动，不连接 Qdrant，不生成 embedding，现有功能完全不受影响

#### Scenario: 显式开启
- **WHEN** CHAT_INDEX_ENABLED=true
- **THEN** 系统启动时连接 Qdrant，创建 collection（如不存在），开始实时索引
