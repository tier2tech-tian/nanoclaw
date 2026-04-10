## ADDED Requirements

### Requirement: Bot 回复持久化单元测试
系统 SHALL 通过单元测试验证 bot 回复入库逻辑和异常处理。

#### Scenario: Bot 回复正常入库
- **GIVEN** agent 完成一轮回复（文本内容非空）
- **WHEN** 调用 storeMessage(is_bot_message=1)
- **THEN** messages 表新增一条 is_bot_message=1 的记录，sender 为 agent 标识

#### Scenario: Bot 回复入库失败不阻塞主流程
- **GIVEN** mock storeMessage 抛出异常（如磁盘满）
- **WHEN** agent 回复完成后触发入库
- **THEN** 异常被 catch，记录 warn 日志，消息收发流程正常继续

### Requirement: 开关控制单元测试
系统 SHALL 通过单元测试验证 CHAT_INDEX_ENABLED 开关行为。

#### Scenario: 默认关闭不初始化
- **GIVEN** CHAT_INDEX_ENABLED 未设置或为 false
- **WHEN** 系统启动
- **THEN** ChatIndex 不初始化，不连接 Qdrant，不生成 embedding

#### Scenario: 显式开启时初始化
- **GIVEN** CHAT_INDEX_ENABLED=true
- **WHEN** 系统启动
- **THEN** ChatIndex 初始化，连接 Qdrant，创建 collection

### Requirement: 分块逻辑单元测试
系统 SHALL 通过单元测试验证 chat-index.ts 的分块（chunking）逻辑正确性。测试使用 vitest + `_initTestDatabase()` 内存数据库，不依赖外部服务。

#### Scenario: 正常对话分块
- **GIVEN** 一条用户消息（"权限怎么配？"）和一条 bot 回复（"需要在设置里…"）
- **WHEN** 调用分块函数
- **THEN** 生成 1 个 chunk，chunk_text 包含双方内容，sender_names 包含用户名，start_time ≤ end_time，message_ids 包含两条消息 ID

#### Scenario: 确定性 chunk ID
- **GIVEN** 相同的 group_folder、chat_jid、message_ids
- **WHEN** 两次调用分块函数
- **THEN** 两次生成的 chunk ID 完全相同（sha256 确定性哈希）

#### Scenario: 不同消息组合产生不同 chunk ID
- **GIVEN** 相同 group_folder 和 chat_jid，但不同的 message_ids
- **WHEN** 分别调用分块函数
- **THEN** 生成不同的 chunk ID

#### Scenario: 超长对话截断
- **GIVEN** 一轮对话文本超过 500 token
- **WHEN** 调用分块函数
- **THEN** 截断为多个 chunk，相邻 chunk 之间有 100 token 重叠，每个 chunk ≤ 500 token

#### Scenario: 噪声过滤 — tool_result 丢弃
- **GIVEN** 消息内容包含 `<tool_result>` 标签和大段输出
- **WHEN** 调用分块函数
- **THEN** tool_result 内容被丢弃，仅保留工具名

#### Scenario: 噪声过滤 — internal 标签丢弃
- **GIVEN** 消息内容包含 `<internal>思考过程...</internal>` 标签
- **WHEN** 调用分块函数
- **THEN** internal 标签及其内容被完全丢弃

#### Scenario: 空内容跳过
- **GIVEN** bot 回复内容为空字符串或纯空白
- **WHEN** 调用分块函数
- **THEN** 不生成 chunk，不写入数据库

### Requirement: FTS5 写入与检索单元测试
系统 SHALL 通过单元测试验证 chat_chunks + chat_chunks_fts 的写入和检索正确性。

#### Scenario: 写入后 FTS5 可检索
- **GIVEN** 一个 chunk 被插入 chat_chunks 表
- **WHEN** 用 FTS5 MATCH 检索 chunk_text 中的关键词
- **THEN** 能命中该 chunk，返回正确的 rowid

#### Scenario: trigram 中文子串匹配（≥3 字符）
- **GIVEN** chunk_text 包含 "权限体系设计方案"
- **WHEN** FTS5 MATCH "权限体系"（4 字符，≥ trigram 最小长度 3）
- **THEN** 命中该 chunk

#### Scenario: trigram 短查询边界（< 3 字符）
- **GIVEN** chunk_text 包含 "权限体系设计方案"
- **WHEN** FTS5 MATCH "权限"（2 字符，< trigram 最小长度 3）
- **THEN** 不命中（trigram tokenizer 无法匹配少于 3 字符的查询，这是已知限制）

#### Scenario: FTS5 BM25 排序
- **GIVEN** 两个 chunk，A 包含关键词 3 次，B 包含 1 次
- **WHEN** FTS5 MATCH 该关键词并用 bm25() 排序
- **THEN** A 的 BM25 分数高于 B

#### Scenario: 幂等写入
- **GIVEN** 一个 chunk（id='abc123'）已存在于 chat_chunks 表
- **WHEN** 再次插入相同 id 的 chunk
- **THEN** 使用 INSERT OR IGNORE，不报错，不产生重复记录

### Requirement: Qdrant 连接与降级单元测试
系统 SHALL 通过单元测试验证 Qdrant 连接管理和降级逻辑。可 mock QdrantClient。

#### Scenario: Qdrant 健康正常
- **GIVEN** mock QdrantClient.healthCheck() 返回成功
- **WHEN** ChatIndex 初始化
- **THEN** qdrantAvailable = true，collection 创建/验证成功

#### Scenario: Qdrant 连接超时降级
- **GIVEN** mock QdrantClient.healthCheck() 抛出连接超时
- **WHEN** ChatIndex 初始化
- **THEN** qdrantAvailable = false，记录 warn 日志，不阻塞启动

#### Scenario: Qdrant 写入失败标记 qdrant_indexed=0
- **GIVEN** mock QdrantClient.upsert() 抛出异常
- **WHEN** batchIndex() 执行
- **THEN** chunk 仍写入 SQLite（chat_chunks + FTS5），qdrant_indexed=0

#### Scenario: 启动时重试未索引的 chunk
- **GIVEN** 数据库中有 3 条 qdrant_indexed=0 的 chunk
- **WHEN** ChatIndex 初始化并执行 retryUnindexed()
- **THEN** 为每条 chunk 重新调用 embedding + Qdrant upsert，成功后标记 qdrant_indexed=1

### Requirement: 防抖调度单元测试
系统 SHALL 通过单元测试验证防抖机制的正确性。

#### Scenario: 防抖合并
- **GIVEN** CHAT_INDEX_DEBOUNCE_MS=100（测试用短间隔）
- **WHEN** 50ms 内连续 enqueue 3 次
- **THEN** batchIndex() 只执行 1 次，处理所有 3 条待索引消息

#### Scenario: 防抖超时后触发
- **GIVEN** enqueue 1 次
- **WHEN** 等待超过 DEBOUNCE_MS
- **THEN** batchIndex() 被触发 1 次

#### Scenario: 索引不阻塞 enqueue
- **GIVEN** batchIndex() 正在执行（mock 为耗时 200ms）
- **WHEN** 此时 enqueue 新消息
- **THEN** enqueue 立即返回，新消息进入下一轮 batch

#### Scenario: 并发安全 — batchIndex 串行执行
- **GIVEN** 第一个 batchIndex() 正在执行
- **WHEN** 第二个 debounce 到期触发
- **THEN** 第二个 batchIndex 等待第一个完成后再执行（互斥锁保护），不并发运行

#### Scenario: shutdown 时 flush 剩余队列
- **GIVEN** 消息已 enqueue 但 debounce 未到期
- **WHEN** 调用 chatIndex.dispose()
- **THEN** 立即执行 batchIndex 处理剩余队列，不丢失数据

### Requirement: 双路检索集成测试
系统 SHALL 通过集成测试验证 Qdrant cosine + FTS5 BM25 双路检索的融合正确性。集成测试需要真实 Qdrant Docker 实例。

#### Scenario: 双路融合排序
- **GIVEN** 索引中有 5 个 chunk，其中 chunk_A 语义相关（高 cosine），chunk_B 关键词匹配（高 BM25），chunk_C 两路都匹配
- **WHEN** 执行 search("权限配置方案")
- **THEN** chunk_C 排名最高（双路加权），chunk_A 和 chunk_B 排名低于 chunk_C

#### Scenario: 时间衰减影响排序
- **GIVEN** chunk_old（180 天前，高相关度）和 chunk_new（1 天前，中等相关度）
- **WHEN** 执行 search()
- **THEN** chunk_new 排名高于 chunk_old（180 天约 1/4 衰减，足以逆转相关度差距）

#### Scenario: MMR 去重生效
- **GIVEN** 索引中有 3 个内容高度相似的 chunk（互相 cosine > 0.9），Qdrant 可用
- **WHEN** 执行 search()，limit=3
- **THEN** top-3 不会全部是这 3 个相似 chunk，MMR 降权后会引入其他不相似的 chunk

#### Scenario: Qdrant 不可用时 FTS5-only 降级
- **GIVEN** Qdrant 服务已停止（连接不上）
- **WHEN** 执行 search("权限配置")
- **THEN** 仅返回 FTS5 结果，无 MMR 去重，记录 warn 日志，不抛异常

#### Scenario: 按群过滤
- **GIVEN** 索引中有 groupA 和 groupB 的 chunk
- **WHEN** search("方案", { group: "groupA" })
- **THEN** 仅返回 groupA 的结果

#### Scenario: 按时间过滤
- **GIVEN** 索引中有今天和 30 天前的 chunk
- **WHEN** search("方案", { days: 7 })
- **THEN** 仅返回最近 7 天内的结果

#### Scenario: 按发送人过滤
- **GIVEN** 索引中有 "大杰" 和 "大狗" 的 chunk
- **WHEN** search("方案", { sender: "大杰" })
- **THEN** 仅返回 sender_names 包含 "大杰" 的结果

#### Scenario: limit 参数
- **GIVEN** 索引中有 20 个匹配 chunk
- **WHEN** search("方案", { limit: 5 })
- **THEN** 最多返回 5 条结果

#### Scenario: 默认参数
- **WHEN** search("方案")（无 options）
- **THEN** 搜索所有群、不限时间、返回 top-10

### Requirement: IPC search_chat 集成测试
系统 SHALL 通过集成测试验证 IPC search_chat 任务的请求/响应流程。

#### Scenario: 正常 IPC 请求响应
- **GIVEN** 已注册 search_chat IPC handler
- **WHEN** 写入 IPC 任务 `{ type: "search_chat", payload: { query: "权限", options: {} } }`
- **THEN** 在 responses 目录写入结果，包含 results 数组

#### Scenario: IPC 无效参数
- **WHEN** 写入 IPC 任务 `{ type: "search_chat", payload: {} }`（缺少 query）
- **THEN** 返回错误响应，status 为 "error"

#### Scenario: IPC 超时
- **GIVEN** mock search 函数耗时 > 15s
- **WHEN** IPC 任务等待响应
- **THEN** 返回超时错误，不阻塞容器进程

### Requirement: 回填脚本测试
系统 SHALL 通过测试验证回填脚本的幂等性和噪声过滤。

#### Scenario: 回填幂等
- **GIVEN** 已回填过一组 JSONL 文件
- **WHEN** 再次运行回填脚本（相同文件）
- **THEN** 跳过已存在的 chunk（按 id 判断），不重复写入，不重复调 embedding

#### Scenario: 回填噪声过滤
- **GIVEN** JSONL 中包含 type=progress 事件和大段 tool_result
- **WHEN** 回填脚本处理
- **THEN** progress 事件被跳过，tool_result 被摘要化（仅保留工具名）

#### Scenario: 回填 rate limit
- **GIVEN** JSONL 中有 100 个待回填 chunk
- **WHEN** 回填脚本执行
- **THEN** embedding 调用速率不超过 10 req/s

#### Scenario: 回填 JSONL 格式异常
- **GIVEN** JSONL 文件中混入 JSON 解析失败的行或字段缺失的行
- **WHEN** 回填脚本处理
- **THEN** 跳过该行，记录 warn 日志，不中断整体流程

### Requirement: MCP Skill 集成测试
系统 SHALL 通过测试验证 search-chat MCP Skill 的调用和返回格式。

#### Scenario: Skill 正常调用
- **GIVEN** search-chat skill 已注册
- **WHEN** agent 调用 search_chat tool（query: "权限", options: {}）
- **THEN** 通过 IPC 发送请求，返回结果数组

#### Scenario: Skill 返回格式
- **GIVEN** 检索返回 3 条结果
- **WHEN** Skill 格式化输出
- **THEN** 每项包含 chunk_text、score、group_name、sender_names、time_range、message_count 字段

### Requirement: E2E 验证
系统 SHALL 提供端到端验证流程，覆盖从消息发送到搜索结果返回的完整链路。

#### Scenario: 实时索引 E2E
- **GIVEN** NanoClaw 已启动，CHAT_INDEX_ENABLED=true，Qdrant 运行中
- **WHEN** 在群里发一条消息（"测试搜索功能 abc123"），agent 回复完成
- **THEN** 等待 DEBOUNCE_MS + 2s 后，调 search_chat("abc123") 能搜到该对话

#### Scenario: 降级 E2E
- **GIVEN** NanoClaw 已启动，CHAT_INDEX_ENABLED=true，Qdrant 已停止
- **WHEN** 在群里发消息，agent 回复，然后搜索
- **THEN** 消息收发不受影响，search_chat 返回 FTS5-only 结果（可能为空或仅关键词匹配）

#### Scenario: 重启后数据持久化
- **GIVEN** 已索引若干 chunk
- **WHEN** 重启 NanoClaw
- **THEN** 之前索引的 chunk 仍可搜索，qdrant_indexed=0 的 chunk 被自动重试

#### Scenario: 回填后搜索历史
- **GIVEN** 运行过回填脚本，导入了历史 JSONL
- **WHEN** search_chat("三个月前讨论的方案")
- **THEN** 能搜到历史对话片段，包含正确的 group_name、sender_names、time_range

### Requirement: 测试基础设施
系统 SHALL 提供测试辅助函数和 mock 工具，降低测试编写成本。

#### Scenario: 内存数据库初始化
- **GIVEN** 测试文件 import `_initTestDatabase`
- **WHEN** 在 beforeEach 中调用
- **THEN** 创建包含 chat_chunks + chat_chunks_fts 的内存数据库

#### Scenario: Qdrant mock
- **GIVEN** 测试不希望依赖真实 Qdrant
- **WHEN** 使用 mock QdrantClient
- **THEN** mock 提供 healthCheck()、upsert()、search()、getCollections() 方法，可配置返回值和异常

#### Scenario: Embedding mock
- **GIVEN** 单元测试不希望调用真实 DashScope API
- **WHEN** mock getEmbedding()
- **THEN** 返回固定的 1024 维向量（如全 0.1），调用次数可断言

#### Scenario: Embedding 维度异常防御
- **GIVEN** mock getEmbedding() 返回错误维度（如 768 维）
- **WHEN** 尝试 upsert 到 Qdrant
- **THEN** 系统跳过该 chunk 并记录 error 日志，标记 qdrant_indexed=0

#### Scenario: 集成测试环境检测
- **GIVEN** 集成测试需要 Qdrant Docker
- **WHEN** Qdrant 未运行
- **THEN** 集成测试自动 skip（`describe.skipIf(!qdrantAvailable)`），不阻塞 CI
