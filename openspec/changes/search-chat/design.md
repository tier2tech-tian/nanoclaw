## Context

NanoClaw 当前存储链路：
- **messages.db**：`storeMessage()` 仅存用户消息（`is_bot_message=0`），无全文索引
- **memory.db**：LLM 提炼的 facts，有 cosine + FTS5 双路召回（`MemoryStore`）
- **JSONL sessions**：完整对话（含 tool_call），无任何索引
- **conversations/*.md**：Markdown 导出，无索引

现有记忆系统的 `MemoryStore` 使用 DashScope embedding + SQLite cosine + FTS5，已验证可靠。动态注入（`buildMessageContext()`）已在 `src/memory/inject.ts` 中提取了共享函数：`extractKeywords()`、`matchWikiEntries()`、`recallRelevantFacts()`。

## Goals / Non-Goals

**Goals:**
- 用户可通过 MCP skill 搜索所有群的完整历史聊天记录
- 向量语义检索 + 关键词精确检索双路融合
- 实时索引（新消息自动入索引）+ 历史回填（存量数据导入）
- Qdrant 不可用时优雅降级，不影响主流程

**Non-Goals:**
- 不做自动上下文注入（仅主动搜索，不在每条消息自动注入聊天历史）
- 不做跨实例同步（仅本地单机）
- 不替换现有 memory.db 的 facts 召回链路
- 不做实时流式索引（防抖批量即可）

## Decisions

### D1: 向量数据库选型 — Qdrant Docker

**选择**: Qdrant (Docker 部署)
**备选**: sqlite-vec（嵌入式）

| 维度 | Qdrant | sqlite-vec |
|------|--------|------------|
| 索引算法 | HNSW（对数复杂度） | 暴力扫描 O(n) |
| 万级性能 | <10ms | ~100ms |
| 十万级性能 | <50ms | ~1s+ |
| 额外进程 | Docker ~100-200MB | 无 |
| 过滤 | payload filter（服务端） | 应用层过滤 |

**理由**: 聊天记录增长快，预计半年内过万级。Qdrant HNSW 索引在这个量级有数量级优势。M1 16GB 跑 Docker Qdrant 完全没问题。

### D2: 分块策略 — 对话轮次 + 滑动窗口

**选择**: 用户消息 + agent 回复 = 1 chunk，超长截断 + 100 token 重叠
**备选**: 固定 token 窗口、单条消息

**理由**: 对话轮次是最自然的语义单元。用户搜"上次讨论的方案"时，问题和回答在同一个 chunk 里才有完整语义。

### D3: Embedding 模型 — 复用 DashScope text-embedding-v4

**选择**: 复用现有 MemoryStore 的 DashScope 配置
**备选**: 本地 embedding（如 nomic-embed）

**理由**: 零配置成本，已验证稳定，1024 维对中英文混合场景效果好。单次 ~100ms，防抖后批量调用可接受。

### D4: FTS5 tokenizer — trigram

**选择**: trigram
**备选**: jieba 分词、unicode61

**理由**: trigram 对中文无需外部分词器，能匹配任意子串。虽然索引稍大，但 FTS5 本身空间开销可控。与现有 memory.db 的 FTS5 配置一致。

### D5: 数据存储位置 — messages.db 扩展

**选择**: chat_chunks 表 + chat_chunks_fts 虚拟表放在 messages.db
**备选**: 新建独立 chat-index.db

**理由**: messages.db 已有消息数据，chunk 引用 message_ids 做溯源时同库 JOIN 更方便。新增表不影响旧表。

### D6: IPC 模式 — 复用现有文件系统 IPC

**选择**: 复用 tasks/ + responses/ 目录的 atomic write 模式
**备选**: HTTP API、Unix socket

**理由**: 与 memory_recall、get_feishu_token 一致的 IPC 模式，容器内 agent 无需额外网络配置。

### D7: 融合排序 — 复用 memory/hybrid.ts

**选择**: 直接调用 `mergeHybridResults()`，传入 `temporalDecayHalfLife: 90`
**备选**: 重写一套融合逻辑

**理由**: `mergeHybridResults()` 已实现完整的 ID 合并 → 加权融合 → 时间衰减 → MMR 管线，且支持参数化（vectorWeight、textWeight、temporalDecayHalfLife、mmrLambda）。聊天记录用 90 天半衰期（vs facts 的 30 天），因为聊天记录的长尾价值更高——"三个月前讨论的架构方案"仍然有用。

### D8: Chunk ID — 确定性哈希

**选择**: `sha256(group_folder + chat_jid + sorted(message_ids)).slice(0, 32)`
**备选**: UUID

**理由**: UUID 每次生成不同，回填脚本重跑会产生重复 chunk。确定性哈希保证同一组消息无论何时索引都产生相同 ID，实现天然幂等。

### D9: FTS5 查询 — 直接用原始 query

**选择**: 原始 query 直接做 FTS5 MATCH
**备选**: 用 extractKeywords() 预分词后查询

**理由**: chat_chunks_fts 用 trigram tokenizer，分词在索引和查询时由 FTS5 引擎自动完成。extractKeywords() 产出的是 bigram（中文）+ 完整单词（英文），和 trigram 不匹配。直接传原始文本让 trigram 处理效果更好。

### D10: 搜索权限 — 默认全群可搜

**选择**: 所有群默认可搜所有群的记录
**备选**: 按群隔离

**理由**: NanoClaw 是单用户（大杰）系统，所有群都是用户自己的对话，没有多租户隔离需求。跨群搜索是核心价值——"之前在哪个群讨论过 Qdrant"这种需求。

## Schema

### chat_chunks 表（messages.db）

```sql
CREATE TABLE IF NOT EXISTS chat_chunks (
  id TEXT PRIMARY KEY,                    -- sha256(group_folder+chat_jid+sorted_msg_ids)[:32]
  chat_jid TEXT NOT NULL,                 -- 群 JID
  group_folder TEXT NOT NULL,             -- 群目录名（从 registered_groups 查）
  message_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of message row IDs
  chunk_text TEXT NOT NULL,               -- 清洗后的对话文本
  sender_names TEXT NOT NULL DEFAULT '',  -- 参与者名，逗号分隔
  start_time TEXT NOT NULL,               -- ISO 8601
  end_time TEXT NOT NULL,                 -- ISO 8601
  qdrant_indexed INTEGER NOT NULL DEFAULT 0,  -- 0=未索引/失败, 1=已索引
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_chunks_jid ON chat_chunks(chat_jid);
CREATE INDEX IF NOT EXISTS idx_chat_chunks_group ON chat_chunks(group_folder);
CREATE INDEX IF NOT EXISTS idx_chat_chunks_qdrant ON chat_chunks(qdrant_indexed) WHERE qdrant_indexed = 0;
```

### chat_chunks_fts 虚拟表

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chat_chunks_fts USING fts5(
  chunk_text,
  content='chat_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

-- 同步触发器
CREATE TRIGGER IF NOT EXISTS chat_chunks_ai AFTER INSERT ON chat_chunks BEGIN
  INSERT INTO chat_chunks_fts(rowid, chunk_text) VALUES (new.rowid, new.chunk_text);
END;
```

### Qdrant collection

```
collection: chat_chunks
vectors: { size: 1024, distance: Cosine }
-- 使用 Qdrant 默认 HNSW 参数（m=16, ef_construct=100）
payload_index:
  - group_folder: keyword（用于过滤）
  - start_time: datetime（用于时间范围过滤）
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Container Agent                   │
│  search-chat skill → IPC request                │
└──────────────┬──────────────────────────────────┘
               │ (filesystem IPC)
┌──────────────▼──────────────────────────────────┐
│              Host Process (src/ipc.ts)           │
│  case 'search_chat' → chatIndex.search()        │
└──────────────┬──────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│         src/chat-index.ts                        │
│                                                  │
│  ┌──────────┐    ┌───────────┐                  │
│  │ Qdrant   │    │ SQLite    │                  │
│  │ cosine   │    │ FTS5/BM25 │                  │
│  └────┬─────┘    └─────┬─────┘                  │
│       └────────┬───────┘                        │
│            融合 + 衰减 + MMR                     │
└─────────────────────────────────────────────────┘
```

## 写入链路

```
bot 回复完成
  ↓
storeMessage(bot reply, is_bot_message=1)
  ↓
chatIndex.enqueue(userMsg + botReply, metadata)
  ↓
debounce 5s
  ↓
batchIndex()
  ├─ 分块（对话轮次合并，确定性 chunk id）
  ├─ DashScope embedding（逐条调用，无 batch API）
  ├─ Qdrant upsert（失败则标记 qdrant_indexed=0）
  └─ FTS5 insert（同步触发器自动维护）
```

注：DashScope text-embedding-v4 不支持 batch API，需逐条调用。防抖的主要价值是合并多轮对话的 chunk 生成，而非减少 embedding 调用次数。

## Risks / Trade-offs

**[Qdrant Docker 进程挂掉]** → 启动时 health check，运行时每次写入 try-catch 降级到 FTS5-only。不影响消息收发。启动时自动重试 qdrant_indexed=0 的 chunk（限 100 条）。

**[DashScope embedding 费用]** → 逐条调用，单条 ~0.001 元。日均几百条消息 = 几毛钱/天。

**[FTS5 trigram 索引膨胀]** → 预估万级 chunk 约 50-100MB，可接受。

**[回填脚本耗时]** → JSONL 文件大时 embedding 调用量大。加 rate limit（10 req/s）+ 进度条。预计千级 session 约 10-30 分钟。

**[messages.db 锁竞争]** → 写入 chat_chunks 时可能与消息循环的 storeMessage 竞争。使用 WAL 模式（已启用）缓解。

**[group_folder 解析]** → chat_chunks 需要 group_folder 做过滤，但 messages 表无此字段。分块时从 registered_groups 表通过 chat_jid 查 folder。如果群未注册（不应发生），跳过索引。

## Migration Plan

1. **部署 Qdrant**: `docker run -d --name qdrant ...`，数据挂载 `store/qdrant/`
2. **代码部署**: 合入 main，重启 NanoClaw
3. **设置环境变量**: `CHAT_INDEX_ENABLED=true`
4. **运行回填**: `npx tsx scripts/backfill-chat-index.ts`
5. **验证**: 在群里调 search_chat skill 测试

**回滚**:
1. `CHAT_INDEX_ENABLED=false` → 索引停止
2. `docker stop qdrant && docker rm qdrant` → 释放资源
3. `rm -rf store/qdrant/` → 清理 Qdrant 持久化数据
4. 删 chat_chunks 表 → `DROP TABLE IF EXISTS chat_chunks_fts; DROP TABLE IF EXISTS chat_chunks;`
5. 不需要回滚 bot 回复入库（多存的数据无害）
