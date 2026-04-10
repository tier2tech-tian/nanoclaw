## Why

NanoClaw 当前没有对聊天记录的检索能力。messages.db 只存用户消息（不存 bot 回复），且没有任何索引。现有的双路召回（cosine + FTS5）只作用于 memory.db 中 LLM 提炼的几十条 facts，无法搜索原始对话内容。当用户需要回忆"上次讨论过的某个方案"或"之前解决过的某个问题"时，只能手动翻 conversations/ 目录的 Markdown 文件。需要一个主动调用的聊天记录检索能力，覆盖所有群的完整历史对话。

## What Changes

- 新增 Qdrant 向量数据库服务（Docker 部署），用于存储聊天记录的 embedding 向量
- 新增 `src/chat-index/` 模块：消息分块、embedding 生成、Qdrant + FTS5 双路写入、双路融合检索
- 修改 `src/db.ts`：新增 `chat_chunks` 表和 `chat_chunks_fts` FTS5 虚拟表
- 修改 `src/index.ts`：agent 回复后调用 `storeMessage` 存入 bot 回复；新消息写入后触发异步索引
- 新增 `src/ipc.ts` 中 `search_chat` IPC 任务类型
- 新增 `container/skills/search-chat/` skill：容器内 agent 通过 IPC 调用检索
- 新增历史回填脚本 `scripts/backfill-chat-index.ts`：从 JSONL session 文件导入存量数据

## Capabilities

### New Capabilities
- `chat-indexing`: 聊天记录实时索引管道 — 消息分块、embedding 生成、Qdrant upsert + FTS5 insert，支持增量索引和历史回填
- `chat-search`: 双路召回检索引擎 — Qdrant cosine 向量检索 + SQLite FTS5/BM25 关键词检索，加权融合（0.7:0.3）、时间衰减、MMR 去重，通过 MCP skill 暴露给 agent
- `chat-testing`: 测试验证体系 — 单元测试（分块/FTS5/Qdrant降级/防抖）、集成测试（双路融合/过滤/IPC）、回填脚本测试、E2E 验证流程

### Modified Capabilities
- `structured-memory`: 修改 messages.db 写入逻辑，bot 回复也存入 messages 表（新增 `is_bot_message=1` 的记录），不影响现有查询（已有 `is_bot_message` 过滤）

## Impact

- **依赖**: 新增 Qdrant Docker 服务（常驻进程，~200MB 内存）；新增 `@qdrant/js-client-rest` npm 包
- **环境变量**: 新增 `QDRANT_URL`（默认 `http://localhost:6333`）、`CHAT_INDEX_ENABLED`（默认 `false`）、`CHAT_INDEX_DEBOUNCE_MS`（默认 `5000`）
- **存储**: messages.db 新增 `chat_chunks` 表 + `chat_chunks_fts` 虚拟表；Qdrant 数据持久化到 `store/qdrant/`
- **外部服务**: DashScope text-embedding-v4（复用现有记忆系统的 embedding 配置）
- **性能**: 索引管道全异步，不影响消息收发延迟；Qdrant 挂掉时跳过索引，不阻塞主流程
- **兼容性**: `CHAT_INDEX_ENABLED=false` 时完全不影响已有功能；bot 回复入库对现有查询无影响（已有 `is_bot_message` 过滤逻辑）
