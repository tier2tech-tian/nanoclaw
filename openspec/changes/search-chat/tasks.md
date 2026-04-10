## 1. 基础设施

- [ ] 1.1 Docker 部署 Qdrant，数据挂载到 store/qdrant/，验证 health check
- [ ] 1.2 npm install @qdrant/js-client-rest，添加到 package.json
- [ ] 1.3 src/db.ts 新增 chat_chunks 表 + chat_chunks_fts FTS5 虚拟表（trigram tokenizer），启动时自动建表

## 2. Bot 回复入库

- [ ] 2.1 src/index.ts：agent 回复完成后调 storeMessage 存 bot 回复（is_bot_message=1），try-catch 包裹

## 3. 索引管道 (src/chat-index.ts)

- [ ] 3.1 新建 src/chat-index.ts 模块，导出 ChatIndex class
- [ ] 3.2 实现分块逻辑：对话轮次合并、500 token 截断 + 100 token 重叠、噪声过滤（tool_result 丢弃、internal 丢弃）
- [ ] 3.3 实现 Qdrant 连接管理：启动 health check、连接失败降级、创建 chat_chunks collection（1024 维 cosine）
- [ ] 3.4 实现 embedding 生成：复用 DashScope text-embedding-v4 配置
- [ ] 3.5 实现 batchIndex()：分块（确定性 chunk id）→ embedding（逐条调用）→ Qdrant upsert + FTS5 insert，全 try-catch
- [ ] 3.6 实现防抖调度：CHAT_INDEX_DEBOUNCE_MS（默认 5000ms），bot 回复入库后触发
- [ ] 3.7 实现启动时重试：扫描 qdrant_indexed=0 的 chunk（限 100 条），重新 embedding + upsert

## 4. 双路检索引擎 (src/chat-index.ts)

- [ ] 4.1 实现 Qdrant cosine 检索：支持 group_folder、start_time payload 过滤
- [ ] 4.2 实现 FTS5 BM25 检索：直接用原始 query 做 FTS5 MATCH（trigram tokenizer 自动处理，不用 extractKeywords）
- [ ] 4.3 实现融合排序：复用 memory/hybrid.ts 的 mergeHybridResults()，传入 temporalDecayHalfLife: 90
- [ ] 4.4 Qdrant 不可用时跳过 MMR（无 embedding 向量），FTS5-only 直接按分数排序
- [ ] 4.5 实现过滤参数：group、sender、days、limit

## 5. IPC 集成

- [ ] 5.1 src/ipc.ts 新增 search_chat case：接收 query + options，调 chatIndex.search()，写 response
- [ ] 5.2 src/index.ts 消息循环中触发异步索引 hook（storeMessage 后调 chatIndex.enqueue）

## 6. MCP Skill

- [ ] 6.1 新建 container/skills/search-chat/SKILL.md：触发词、描述
- [ ] 6.2 新建 container/skills/search-chat/search-chat.mjs：IPC 调用封装，结果格式化
- [ ] 6.3 SKILL.md 注册 MCP tool schema（query: string, options: object）

## 7. 历史回填

- [ ] 7.1 新建 scripts/backfill-chat-index.ts：遍历 JSONL → 分块 → embedding → Qdrant + FTS5
- [ ] 7.2 实现噪声过滤（skip progress、tool_result 摘要化）
- [ ] 7.3 实现幂等（chunk id 已存在则跳过）
- [ ] 7.4 加 rate limit（10 req/s）+ 进度条

## 8. 开关与配置

- [ ] 8.1 新增环境变量：CHAT_INDEX_ENABLED（默认 false）、QDRANT_URL（默认 http://localhost:6333）、CHAT_INDEX_DEBOUNCE_MS（默认 5000）
- [ ] 8.2 CHAT_INDEX_ENABLED=false 时完全跳过索引管道初始化

## 9. 测试基础设施

- [ ] 9.1 确认 _initTestDatabase() 创建 chat_chunks + chat_chunks_fts 表（db.ts createSchema 已包含）
- [ ] 9.2 编写 Qdrant mock（mockQdrantClient：healthCheck/upsert/search/getCollections 可配置返回值和异常）
- [ ] 9.3 编写 embedding mock（固定 1024 维向量，调用次数可断言）
- [ ] 9.4 集成测试环境检测：describe.skipIf(!qdrantAvailable)，Qdrant 未运行时自动 skip

## 10. 单元测试 (src/chat-index.test.ts)

- [ ] 10.1 Bot 回复入库：正常入库 is_bot_message=1、入库异常 catch + warn 日志不阻塞主流程
- [ ] 10.2 开关控制：CHAT_INDEX_ENABLED=false 不初始化、=true 初始化连接 Qdrant
- [ ] 10.3 分块逻辑：正常对话分块（用户+bot → 1 chunk，含 sender_names/time/message_ids）
- [ ] 10.4 分块逻辑：确定性 chunk ID（相同输入 → 相同 ID，不同输入 → 不同 ID）
- [ ] 10.5 分块逻辑：超长对话截断（>500 token → 多 chunk，相邻 100 token 重叠）
- [ ] 10.6 分块逻辑：噪声过滤（tool_result 丢弃仅保留工具名、internal 标签丢弃）
- [ ] 10.7 分块逻辑：空内容跳过（不生成 chunk）
- [ ] 10.8 FTS5 写入与检索：写入后 MATCH 可命中、trigram ≥3 字符中文匹配、<3 字符不命中、BM25 排序
- [ ] 10.9 FTS5 幂等写入：INSERT OR IGNORE 不报错不重复
- [ ] 10.10 Qdrant 降级：连接超时 → qdrantAvailable=false、写入失败 → qdrant_indexed=0
- [ ] 10.11 Qdrant 启动重试：扫描 qdrant_indexed=0 → 重新 embedding + upsert → 标记=1
- [ ] 10.12 防抖调度：连续 enqueue 合并为 1 次 batchIndex、超时后触发、索引中不阻塞 enqueue
- [ ] 10.13 防抖并发安全：batchIndex 串行执行（互斥锁）、shutdown 时 flush 剩余队列
- [ ] 10.14 Embedding 维度异常：返回错误维度时跳过 chunk + error 日志 + qdrant_indexed=0

## 11. 集成测试 (src/chat-index.integration.test.ts)

- [ ] 11.1 双路融合排序：语义+关键词双命中 > 单路命中
- [ ] 11.2 时间衰减：180 天前高相关度 < 1 天前中等相关度
- [ ] 11.3 MMR 去重：3 个高度相似 chunk（cosine>0.9）搜索后不会全占 top-K
- [ ] 11.4 Qdrant 不可用降级：FTS5-only 返回结果、无 MMR、warn 日志
- [ ] 11.5 过滤参数：group 过滤、days 过滤、sender 过滤、limit 参数、默认参数（全群/不限时间/top-10）
- [ ] 11.6 IPC search_chat：正常请求响应、缺少 query 返回错误、超时返回错误
- [ ] 11.7 MCP Skill：Skill 正常调用 + 返回格式验证（chunk_text/score/group_name/sender_names/time_range/message_count）

## 12. 回填脚本测试 (scripts/backfill-chat-index.test.ts)

- [ ] 12.1 回填幂等：重复运行不重复写入、不重复调 embedding
- [ ] 12.2 回填噪声过滤：progress 事件跳过、tool_result 摘要化
- [ ] 12.3 回填 rate limit：embedding 调用速率 ≤ 10 req/s
- [ ] 12.4 回填 JSONL 格式异常：解析失败行跳过 + warn 日志、不中断流程

## 13. E2E 验证（手动 + 脚本辅助）

- [ ] 13.1 实时索引 E2E：发消息 → agent 回复 → 等索引 → search_chat 搜到
- [ ] 13.2 降级 E2E：停 Qdrant → 发消息 → 收发正常 → search_chat 返回 FTS5-only 结果
- [ ] 13.3 重启持久化：重启 NanoClaw → 之前索引的 chunk 仍可搜索 → qdrant_indexed=0 自动重试
- [ ] 13.4 回填后搜索历史：运行回填 → search_chat 搜到历史对话 → group_name/sender_names/time_range 正确
