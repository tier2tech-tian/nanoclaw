# per-message-context-injection

每条消息经过宿主时，动态匹配 Wiki 和记忆，注入到 agent prompt stream。

## ADDED Requirements

### Requirement: 宿主侧消息预处理

当 container active 时，宿主 SHALL 在发送 IPC message 前调用 `buildMessageContext(text, userId)` 提取当前消息相关的 Wiki 条目和记忆事实。

#### Scenario: 正常匹配

- **WHEN** 用户发送消息 "Nine 项目的 Git 工作流是什么" 且 container active
- **THEN** 宿主调用 `buildMessageContext()`，返回 Wiki 命中 `nine-dev-workflow.md` + 相关记忆 facts
- **THEN** IPC message payload 中包含 `context: { wiki: [...], facts: [...] }`

#### Scenario: 无匹配结果

- **WHEN** 用户发送消息 "你好" 且没有 Wiki/记忆命中
- **THEN** `buildMessageContext()` 返回 null
- **THEN** IPC message payload 中 `context` 字段为 null 或不存在

#### Scenario: 记忆系统禁用

- **WHEN** `isMemoryEnabled()` 返回 false
- **THEN** 跳过 `buildMessageContext()` 调用
- **THEN** IPC message payload 不含 `context` 字段

### Requirement: context 去重

宿主 SHALL 维护 per-group 的 context hash 缓存，当连续消息匹配到相同的 Wiki/记忆结果时，不重复注入。

#### Scenario: 连续同话题消息

- **WHEN** 用户连续发送两条关于 "Git 工作流" 的消息
- **THEN** 第一条消息携带 context
- **THEN** 第二条消息 context 为 null（因 hash 相同，去重命中）

#### Scenario: 话题切换

- **WHEN** 用户先问 "Git 工作流" 再问 "飞书 E2E 测试"
- **THEN** 两条消息都携带 context（因 hash 不同）

### Requirement: IPC message schema 扩展

现有 `type: 'message'` 的 IPC payload SHALL 新增可选 `context` 字段，用于携带 Wiki 和记忆匹配结果。不引入新的 IPC 消息类型。

```json
{
  "type": "message",
  "text": "用户消息",
  "context": {
    "wiki": [{ "title": "标题", "path": "文件路径", "snippet": "摘要" }],
    "facts": [{ "content": "内容", "category": "类别", "confidence": 0.5 }]
  },
  "modelOverride": { "model": "...", "thinking": "..." }
}
```

**context 数据结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `wiki` | `Array<WikiMatch>` | Wiki 匹配条目，可为空数组 |
| `facts` | `Array<FactMatch>` | 记忆召回结果，可为空数组 |

**WikiMatch**：`{ title: string, path: string, snippet: string }`（snippet ≤200 字）
**FactMatch**：`{ content: string, category: string, confidence: number }`（content ≤100 字）

#### Scenario: 空数组处理

- **WHEN** `context.wiki` 为 `[]` 且 `context.facts` 为 `[]`
- **THEN** 等同于 `context` 为 null，agent-runner 不注入上下文

#### Scenario: 旧版宿主向后兼容

- **WHEN** IPC message 不包含 `context` 字段
- **THEN** agent-runner 按现有逻辑处理，不注入上下文

### Requirement: agent-runner 侧 context 拼接

agent-runner 有 **三个** IPC 消息消费入口，每个入口都 SHALL 处理 `context` 字段：

1. **`drainIpcInput()`**（冷启动时消费积压消息 + query 间隙消费新消息）
2. **`pollIpcDuringQuery()`**（query 进行中实时轮询，通过 `stream.push()` 追加）
3. **`waitForIpcMessage()`**（两次 query 之间等待新消息，可能合并多条）

当 IPC message 包含非空 `context` 字段时，SHALL 将其格式化为 `<context>` XML 块，prepend 到用户消息文本前。

#### Scenario: 带 context 的消息

- **WHEN** IPC message 包含 `context: { wiki: [{title: 'Nine 开发规范', ...}], facts: [{content: '...', ...}] }`
- **THEN** 输出的文本为：
  ```
  <context>
  Wiki 相关条目:
    - [Nine 开发规范](nine-dev-workflow.md) — ...
  记忆召回:
    - [knowledge | 0.43] ...
  </context>

  用户原始消息
  ```

#### Scenario: 无 context 的消息

- **WHEN** IPC message 的 `context` 为 null 或不存在
- **THEN** 直接使用 `msg.text`，不添加任何前缀

#### Scenario: context 只有 Wiki 无记忆

- **WHEN** `context.wiki` 非空但 `context.facts` 为空
- **THEN** `<context>` 块只包含 Wiki 部分，不输出"记忆召回"段落

### Requirement: waitForIpcMessage 消息合并时的 context 处理

`waitForIpcMessage()` 可能在一次轮询中获得多条 IPC 消息并合并为一条。合并时 SHALL：

- `text`：各条消息的 text 用 `\n` 拼接（保持现有行为）
- `context`：取**最后一条**消息的 context（最新匹配最相关）
- `modelOverride`：取最后一条的（保持现有行为）

#### Scenario: 合并两条消息，一条有 context 一条无

- **WHEN** message A 有 context，message B 无 context
- **THEN** 合并后 context 为 null（B 的 context 为空 = 最后一条无 context）

#### Scenario: 合并两条消息，两条都有 context

- **WHEN** message A 有 context_A，message B 有 context_B
- **THEN** 合并后 context 为 context_B

### Requirement: 初始 prompt 拼接时的 context 处理

agent-runner 启动时 `drainIpcInput()` 消费积压消息拼入初始 prompt。此时 SHALL 将 pending 消息的 context 也拼入（prepend 到各自 text 前），而非仅拼 text。

#### Scenario: 启动时有积压消息带 context

- **WHEN** 启动时 `drainIpcInput()` 返回 2 条积压消息，第 2 条带 context
- **THEN** 初始 prompt 拼接：`prompt + '\n' + msg1.text + '\n' + formatContext(msg2.context) + '\n\n' + msg2.text`

### Requirement: pollIpcDuringQuery 实时追加时的 context 处理

`pollIpcDuringQuery()` 在 query 进行中通过 `stream.push()` 追加消息。SHALL 在 push 前检查 `msg.context`，非空时 prepend `<context>` 块。

#### Scenario: query 进行中收到带 context 的消息

- **WHEN** `pollIpcDuringQuery` 轮询到一条带 context 的 IPC message
- **THEN** `stream.push(formatContext(msg.context) + '\n\n' + msg.text)`

### Requirement: 冷启动兼容

冷启动路径（`runAgent()` → `injectMemory()` → 写 CLAUDE.md）SHALL 保持不变，作为首次消息的完整上下文注入。

#### Scenario: 首次消息走冷启动

- **WHEN** container 不 active，用户发送第一条消息
- **THEN** 走 `runAgent()` → `injectMemory()` 写 CLAUDE.md
- **THEN** container 启动时读取完整 Memory section

#### Scenario: 后续消息走动态注入

- **WHEN** container active，用户发送后续消息
- **THEN** 走 `sendMessage()` → `buildMessageContext()` → IPC message with context
- **THEN** 不修改 CLAUDE.md

### Requirement: Token 预算控制

动态注入的 context 块 SHALL 控制在 2000 tokens 以内。

#### Scenario: 超出预算

- **WHEN** Wiki 匹配 5 条 + 记忆 10 条，总计超过 2000 tokens
- **THEN** 按优先级截断：Wiki top 3（每条 snippet ≤200 字）+ 记忆 top 5（每条 ≤100 字）
- **THEN** 截断后总量 ≤ 2000 tokens

#### Scenario: 预算内

- **WHEN** Wiki 匹配 2 条 + 记忆 3 条，总计 500 tokens
- **THEN** 全量注入，不截断
