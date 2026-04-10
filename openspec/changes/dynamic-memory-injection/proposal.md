# Dynamic Memory Injection — Proposal

## Why

当前记忆和 Wiki 上下文仅在 container 冷启动时通过 `injectMemory()` 写入 CLAUDE.md，之后 30 分钟 idle timeout 内所有消息直接走 stdin 追加，**跳过记忆/Wiki 匹配**。导致：

1. **记忆过时**：用户在会话中新增的记忆（通过 MCP `memory_remember`）无法被当前 session 感知
2. **Wiki 匹配固化**：冷启动时按第一条消息匹配的 Wiki 条目，话题切换后不会更新
3. **30 分钟黑洞**：container active 期间，`group-queue.ts` 直接追加 stdin，完全绕过 `injectMemory()`

改进目标：**每条消息都带上基于当前消息内容匹配的最新记忆和 Wiki 上下文**，不依赖 container 重启。

## Capabilities

### New Capabilities

- **per-message-context-injection**：宿主侧每条消息经过时，提取关键词，匹配 Wiki + 召回记忆，在现有 IPC `type: 'message'` payload 中增加 optional `context` 字段，agent-runner 收到后格式化为 `<context>` 块 prepend 到用户消息前

### Modified Capabilities

无。当前 `injectMemory()` 保留作为冷启动兜底，不做修改。

## Impact

### 代码改动

| 文件 | 改动 |
|------|------|
| `src/index.ts` | 消息预处理：每条消息到达时调用 Wiki/记忆匹配，生成 context payload |
| `src/group-queue.ts` | Container active 分支：`sendMessage()` 增加 `context` 参数，写入 IPC message payload |
| `src/memory/inject.ts` | 抽取"关键词提取 + Wiki 匹配 + 记忆召回"为独立函数，支持按需调用 |
| `container/agent-runner/src/index.ts` | `drainIpcInput()`、`waitForIpcMessage()`、`pollIpcDuringQuery()` 三个 IPC 消费入口均处理 `context` 字段，格式化为 `<context>` 块拼入 prompt |

### Token 开销

每条消息额外 500-2000 tokens（记忆摘要 + Wiki 片段），取决于匹配命中数。可通过以下方式控制：
- Wiki 匹配上限：top 3 条目，每条截取摘要前 200 字
- 记忆召回上限：top 5 条，每条限 100 字
- 当匹配结果与上一次相同时，跳过注入（去重）

### 向后兼容

- 冷启动的 `injectMemory()` + CLAUDE.md 写入保留不变，作为 fallback
- 新逻辑为增量叠加，不改变现有行为
- IPC message 的 `context` 字段为 optional，旧版宿主不发时 agent-runner 行为不变

### 风险

- prompt stream 拼接位置需精确，避免打断用户消息或 system prompt 结构
- 高频消息场景下 IPC 写入需考虑竞争（文件锁或 atomic write）
