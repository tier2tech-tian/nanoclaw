## Why

记忆召回（recall）和全量加载（loadFacts）目前按 `group_folder` 隔离——A 群存的记忆，B 群查不到。但实际场景是**同一个用户所有群共享一套记忆**，用户已多次明确要求"只按 user_id 查，不要按群查"。

当前代码中，以下路径存在 group_folder 隔离：

| 函数 | 文件 | 行为 |
|------|------|------|
| `loadFacts()` | storage.ts:160 | `WHERE group_folder = ? AND user_id = ?` |
| `loadProfile()` | storage.ts:120 | `WHERE group_folder = ? AND user_id = ?` |
| `searchFts()` | keyword-store.ts:71 | 只按 user_id（group_folder 参数被忽略——恰好符合预期） |
| `searchLike()` | keyword-store.ts:118 | 只按 user_id（group_folder 参数被忽略——恰好符合预期） |
| `injectMemory()` | inject.ts:37 | 传 groupFolder 给 loadFacts/loadProfile |
| `memory_recall` IPC | ipc.ts:572,582 | 传 sourceGroup 给 MemoryStore/loadFacts |

## What Changes

**核心原则：存储时保留 group_folder（溯源用），召回时只按 user_id 查。**

### 1. `loadFacts(userId)` — 去掉 group_folder 过滤

```
- WHERE group_folder = ? AND user_id = ?
+ WHERE user_id = ?
```

函数签名改为 `loadFacts(userId: string)`，groupFolder 参数移除。

### 2. `loadProfile(userId)` — 跨群合并 profile

```
- WHERE group_folder = ? AND user_id = ?
+ WHERE user_id = ?
  ORDER BY updated_at DESC LIMIT 1
```

取最近更新的那条 profile。函数签名改为 `loadProfile(userId: string)`。

### 3. `injectMemory()` — 调用处适配

```typescript
// Before
const profile = loadProfile(groupFolder, userId);
const allFacts = loadFacts(groupFolder, userId);
const store = new MemoryStore(groupFolder, userId);

// After
const profile = loadProfile(userId);
const allFacts = loadFacts(userId);
const store = new MemoryStore(userId);  // groupFolder 不再传入 recall 路径
```

### 4. `MemoryStore` — recall 路径去掉 groupFolder

`MemoryStore.recall()` 内部调 `keywordSearch(query, groupFolder, topK, userId)`。searchFts/searchLike 本来就没用 groupFolder，但需要清理参数传递链：

- `keywordSearch` 签名去掉 `groupFolder` 参数
- `searchFts` / `searchLike` 签名去掉 `groupFolder` 参数

### 5. `memory_recall` IPC handler — 去掉 sourceGroup 过滤

```typescript
// Before
const store = new MemoryStore(sourceGroup, userId);
const allFacts = loadFacts(sourceGroup, userId);

// After
const store = new MemoryStore(userId);
const allFacts = loadFacts(userId);
```

### 6. 召回 query 增强 — 拼接最近对话上下文

当前 `injectMemory` 只传 `latestUserMessage`（单条用户消息）做召回 query，语义信息不足。

改为：在 `index.ts` 调用 `injectMemory` 时，拼接最近 2 条用户消息 + 2 条 agent 回复作为 query，提升召回质量。

### 不改的部分

- **`storeFactRaw()` / `storeFacts()`**：写入时仍保留 `group_folder`，用于溯源
- **`saveProfile()`**：写入时仍保留 `group_folder` 作为 PK
- **`enforceMaxFacts()`**：已经只按 user_id，不需要改
- **`updateFact()` / `removeFacts()`**：按 id 操作，不涉及召回隔离

## Impact

- **无数据库 schema 变更**：group_folder 列保留，只是查询时不再作为过滤条件
- **无新依赖**
- **向后兼容**：已有记忆数据不需要迁移，去掉 group_folder 过滤后自动跨群可见
- **profile 合并**：多群各有一条 profile 时取最新的。后续可考虑 LLM 合并，但现阶段 LIMIT 1 够用

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/memory/storage.ts` | loadFacts/loadProfile 去掉 group_folder 参数和 SQL 过滤 |
| `src/memory/keyword-store.ts` | keywordSearch/searchFts/searchLike 去掉 group_folder 参数 |
| `src/memory/memory-store.ts` | 构造函数和 recall 去掉 groupFolder |
| `src/memory/inject.ts` | injectMemory 调用处适配 |
| `src/ipc.ts` | memory_recall handler 适配 |
| `src/index.ts` | injectMemory 调用处：拼接多条消息作为 query |
