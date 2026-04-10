# Dynamic Memory Injection — Design

## Context

### 当前架构

```
用户消息 → index.ts::runAgent()
                ├─ injectMemory() → 写 CLAUDE.md（Memory section）
                └─ spawn container → agent-runner 启动时读 CLAUDE.md
                                              ↓
后续消息 → group-queue.ts
                ├─ Container active? → 直接写 IPC input/*.json
                └─ agent-runner 三个消费入口：
                    ├─ drainIpcInput()      → 启动时消费积压 + query 间隙消费
                    ├─ pollIpcDuringQuery() → query 进行中实时 stream.push()
                    └─ waitForIpcMessage()  → 两次 query 之间等待（可能合并多条）
```

**核心问题**：`injectMemory()` 只在 `runAgent()` 中调用，而 `runAgent()` 只在 container 不 active 时执行。Container active 期间（最长 30 分钟），所有消息通过 `group-queue.ts` → IPC `input/` → 上述三个入口消费，**完全绕过记忆/Wiki 匹配**。

### 约束

1. **Claude SDK 限制**：`systemPrompt` 只在 `query()` 调用时设置一次，无法中途修改
2. **prompt stream 是 AsyncIterable**：通过 `MessageStream.push(text)` 追加用户消息，SDK 将其作为 user turn 处理
3. **IPC 已有机制**：宿主 → container 的 `input/*.json` 轮询机制已稳定运行（500ms 间隔）
4. **记忆存储**：DashScope `text-embedding-v4`（1024 维）远程 embedding + SQLite BLOB 本地存储 + in-memory cosine 召回。不使用 Qdrant

## Goals / Non-Goals

**Goals:**
- 每条消息都基于当前内容匹配最新 Wiki 和记忆
- 利用现有 IPC 机制，最小改动
- 向后兼容：冷启动 CLAUDE.md 注入保留

**Non-Goals:**
- 不改变 Claude SDK 的 `systemPrompt` 传递方式
- 不引入新的进程间通信机制（用现有 IPC 文件轮询）
- 不做 Wiki 向量化召回（后续独立 change）
- 不改变记忆更新/存储逻辑

## Decisions

### Decision 1：在 IPC message 中嵌入 context，而非新增 IPC 类型

**方案 A**（选中）：在现有 `type: 'message'` 的 payload 中增加 optional `context` 字段

```typescript
// 宿主写入 IPC input/*.json
{
  type: 'message',
  text: '用户原始消息',
  context: {
    wiki: [
      { title: 'Nine 平台开发规范', path: 'nine-dev-workflow.md', snippet: 'Git 工作流...' }
    ],
    facts: [
      { content: '记忆召回策略已改为整库查询', category: 'knowledge', confidence: 0.43 }
    ]
  },
  modelOverride?: { model: string, thinking?: string }
}
```

**方案 B**（弃用）：新增 `type: 'context_update'` 消息类型

**选择理由**：方案 A 更简单——context 和 message 天然绑定，不需要管时序问题。方案 B 在高频消息场景下容易出现 race condition。

---

### Decision 2：宿主侧匹配逻辑——独立函数 `buildMessageContext()`

从 `inject.ts` 中抽取**底层共享函数**（关键词提取、Wiki 索引匹配、记忆向量召回），`buildMessageContext()` 和 `injectMemory()` 各自组合调用：

```typescript
// src/memory/inject.ts — 底层共享函数
export function extractKeywords(text: string): string[];
export function matchWikiEntries(text: string, wikiDir: string): WikiMatch[];
export async function recallRelevantFacts(text: string, userId?: string, topK?: number): Promise<FactMatch[]>;

// 新增：动态注入用（返回轻量 context，不写文件）
export async function buildMessageContext(
  latestUserMessage: string,
  userId?: string
): Promise<MessageContext | null> {
  const wikiMatches = matchWikiEntries(latestUserMessage, wikiDir);
  const facts = await recallRelevantFacts(latestUserMessage, userId, 5);
  if (wikiMatches.length === 0 && facts.length === 0) return null;
  return { wiki: wikiMatches, facts };
}

// 现有：冷启动用（完整 profile + facts + wiki → 写 CLAUDE.md）
export async function injectMemory(...) {
  // 内部复用 extractKeywords / matchWikiEntries / recallRelevantFacts
  // 但还做 profile 注入、formatMemoryForInjection、CLAUDE.md 写入等
}
```

**为什么不让 `injectMemory` 直接调用 `buildMessageContext`**：两者输出格式差距大。`injectMemory` 需要完整 profile + markdown 链接格式写入 CLAUDE.md；`buildMessageContext` 返回轻量 JSON 供 IPC 传输。强行复用会引入不必要的耦合。抽取底层函数让两者各自组合更清晰。

---

### Decision 3：调用位置——在 `src/index.ts` 中调 `buildMessageContext()`，而非 `group-queue.ts` 内部

**关键事实**：`GroupQueue.sendMessage()` 的实际签名是：
```typescript
sendMessage(groupJid: string, text: string, modelOverride?: {...}): boolean  // 同步方法
```

它不接收 sender/group 对象，且是同步方法。而 `buildMessageContext()` 是异步的（需要 await 记忆召回）。

因此，context 构建放在 `src/index.ts` 第 933-935 行之间（`formatMessages` 之后、`queue.sendMessage` 之前）：

```typescript
// src/index.ts — container active 分支
const formatted = formatMessages(messagesToSend, TIMEZONE);

// 新增：动态 context 构建（异步）
let context: MessageContext | null = null;
if (isMemoryEnabled(group)) {
  context = await buildMessageContext(formatted, userId);
  // 去重检查
  const hash = context ? hashContext(context) : null;
  if (hash && hash === lastContextHash.get(group.folder)) {
    context = null;
  } else if (hash) {
    lastContextHash.set(group.folder, hash);
  }
}

// sendMessage 增加 context 参数
if (queue.sendMessage(chatJid, formatted, pipeModelOverride, context)) {
  // ...
}
```

`GroupQueue.sendMessage()` 签名调整为：
```typescript
sendMessage(
  groupJid: string,
  text: string,
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' },
  context?: MessageContext | null  // 新增，透传到 IPC payload
): boolean
```

---

### Decision 4：agent-runner 侧——三个 IPC 入口全部处理 context

agent-runner 有三个消费 IPC 消息的入口，全部需要处理 `context`：

#### 4a. `IpcMessage` 接口扩展

```typescript
interface IpcMessage {
  text: string;
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' };
  context?: MessageContext | null;  // 新增
}
```

#### 4b. `drainIpcInput()` — 解析 context 字段

```typescript
// 第 370-371 行
if (data.type === 'message' && data.text) {
  messages.push({
    text: data.text,
    modelOverride: data.modelOverride,
    context: data.context || null,  // 新增
  });
}
```

#### 4c. `waitForIpcMessage()` — 合并时保留最后一条的 context

```typescript
const combined: IpcMessage = {
  text: messages.map(m => m.text).join('\n'),
  modelOverride: messages[messages.length - 1].modelOverride,
  context: messages[messages.length - 1].context || null,  // 新增：取最后一条
};
```

**为什么取最后一条**：多条消息合并时，最后一条的 context 基于最新消息生成，最相关。

#### 4d. `pollIpcDuringQuery()` — stream.push 前 prepend context

```typescript
// 第 474 行改为：
const pushText = msg.context
  ? formatContext(msg.context) + '\n\n' + msg.text
  : msg.text;
stream.push(pushText);
```

#### 4e. 初始 prompt 拼接 — pending 消息带 context

```typescript
// 第 1029-1032 行改为：
const pending = drainIpcInput();
if (pending.length > 0) {
  log(`Draining ${pending.length} pending IPC messages into initial prompt`);
  prompt += '\n' + pending.map(m => {
    return m.context
      ? formatContext(m.context) + '\n\n' + m.text
      : m.text;
  }).join('\n');
}
```

#### 4f. `formatContext()` 实现

```typescript
function formatContext(ctx: MessageContext): string {
  const parts: string[] = ['<context>'];
  if (ctx.wiki?.length) {
    parts.push('Wiki 相关条目:');
    for (const w of ctx.wiki) {
      parts.push(`  - [${w.title}](${w.path}) — ${w.snippet}`);
    }
  }
  if (ctx.facts?.length) {
    parts.push('记忆召回:');
    for (const f of ctx.facts) {
      parts.push(`  - [${f.category} | ${f.confidence.toFixed(2)}] ${f.content}`);
    }
  }
  parts.push('</context>');
  return parts.join('\n');
}
```

**为什么用 `<context>` 而非 `<system-reminder>`**：`system-reminder` 是 Claude Code SDK 内部保留标签，外部使用可能被过滤。`<context>` 更语义化。注意 context 通过 `stream.push()` 注入为 user turn 的一部分，语义地位低于冷启动时 CLAUDE.md 的 system-level context。建议在 SOUL.md 或 CLAUDE.md 中添加说明："`<context>` 标签包含系统动态注入的记忆和 Wiki 上下文，视为可信参考信息"。

---

### Decision 5：去重机制 + 生命周期管理

- 宿主侧维护 `lastContextHash: Map<string, string>`（per group folder）
- 对 `buildMessageContext()` 结果做 JSON hash
- 如果与上次相同，设 `context: null`
- **生命周期**：在 container 退出时（`runForGroup` 的 finally 块或 `GroupQueue` 的 reset 逻辑中）清除该 group 的 hash 缓存，避免新会话首条消息被误去重

---

### Decision 6：类型定义——两侧各自定义，集成测试保证一致

宿主侧在 `src/memory/inject.ts` 定义 `MessageContext`、`WikiMatch`、`FactMatch`；container 侧在 `agent-runner/src/index.ts` 定义相同接口。不建立共享 types 包（当前项目结构不支持 monorepo 共享）。通过集成测试验证两侧 JSON 序列化/反序列化一致。

## Risks / Trade-offs

### Token 开销

| 场景 | 额外 tokens | 说明 |
|------|-------------|------|
| Wiki 命中 3 条 + 记忆 5 条 | ~800-1500 | 典型场景 |
| 去重命中（context 不变） | 0 | 连续同话题消息 |
| 无匹配 | 0 | context 为 null |
| 最大值（满配） | ~2000 | Wiki 5 条 + 记忆 10 条 |

每条消息平均增加 ~500 tokens（考虑去重命中率约 40%）。

**Token 估算注意**：中文字符 token 化比率约 1.5-2 tokens/字，snippet ≤200 字实际可能占 300-400 tokens。截断逻辑应预留余量或使用实际 tokenizer 估算。

### 性能

- `buildMessageContext()` 主要耗时：Wiki 索引读取（~5ms）+ 记忆向量召回（~30ms，in-memory cosine over ~2000 条记录）
- 总延迟 ~35ms，对消息处理链路（通常 >1s）影响可忽略
- SQLite 读取为本地 I/O，不依赖网络。Embedding 生成在写入时完成（DashScope 远程调用），召回时只做本地 cosine

### 兼容性

- 冷启动路径（`runAgent` → `injectMemory` → CLAUDE.md）完全保留
- agent-runner 对 `context` 字段做 optional 处理，旧版宿主不发 context 也正常工作
- IPC message schema 向后兼容（新增 optional 字段）

### 潜在问题

1. **prompt 语义地位**：`<context>` 块通过 `stream.push()` 注入为 user turn 的一部分，而非 system prompt。用户理论上可以说"忽略上面的 context"来干扰。缓解方案：在 SOUL.md 中声明 `<context>` 标签的可信性
2. **文件锁竞争**：高频消息时 IPC 文件写入可能冲突。现有 `writeIpcInput()` 使用 timestamp + random 前缀保证唯一性，风险低
3. **记忆延迟**：新记忆通过 MCP `memory_remember` 写入后，需要等 embedding 异步计算完成（DashScope API 调用 ~1-3s）+ SQLite 写入才能被召回。实际延迟约 2-5s，可接受
4. **降级策略**：`buildMessageContext()` 异常时（如 MemoryStore 超时），context 设为 null，不阻塞消息发送。参考 `injectMemory` 现有的 try-catch 模式
