# Dynamic Memory Injection — 验收用例

## AC1: 冷启动路径不受影响

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 1.1 | Container 不 active 时发送消息 | 走 `runAgent()` → `injectMemory()` → 写 CLAUDE.md | 查 container 日志，确认 Memory section 写入 |
| 1.2 | 冷启动后 agent 回复中引用了 Wiki/记忆内容 | 与改动前行为一致 | 发"Nine 开发规范是什么"，确认 agent 能引用 wiki |

## AC2: Container active 时动态注入 context

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 2.1 | Container active 时发送消息"Nine 的 Git 工作流" | IPC 文件包含 `context.wiki` 命中 `nine-dev-workflow.md` | 检查 `data/ipc/<group>/input/*.json` 内容 |
| 2.2 | agent 回复中引用了 Wiki 内容 | agent 能回答 Nine Git 工作流相关问题 | 检查回复内容 |
| 2.3 | 在同一 session 中话题切换到"飞书 E2E 测试" | 新消息的 IPC 文件 context 更新为新匹配 | 检查 IPC 文件，确认 wiki 条目变化 |

## AC3: 去重机制

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 3.1 | 连续发送两条关于同一话题的消息 | 第一条有 context，第二条 context 为 null | 检查两条 IPC 文件的 context 字段 |
| 3.2 | 话题切换后发消息 | context 不为 null，包含新匹配结果 | 检查 IPC 文件 |

## AC4: 无匹配时不注入

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 4.1 | 发送"你好"等无关键词匹配的消息 | IPC message 的 context 为 null | 检查 IPC 文件 |
| 4.2 | agent 正常回复，不出现空 `<context>` 块 | 无异常 | 检查 agent-runner 日志 |

## AC5: 新记忆实时可召回

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 5.1 | 让 agent 执行 `memory_remember` 记住一个新事实 | 记忆写入成功 | 确认 MCP 调用返回成功 |
| 5.2 | 等待 5 秒后发送与该事实相关的消息 | context.facts 包含刚写入的记忆 | 检查 IPC 文件的 facts 字段 |

## AC6: agent-runner 三个入口全部工作

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 6.1 | Container 启动时有积压消息带 context | 初始 prompt 包含 `<context>` 块 | agent-runner 日志 `Draining N pending IPC messages` + 检查 prompt |
| 6.2 | Query 进行中（agent 正在回复时）发送带 context 的消息 | `pollIpcDuringQuery` 推送的文本前有 `<context>` 块 | agent-runner 日志 `Piping IPC message` + 检查 push 内容 |
| 6.3 | 两次 query 之间发送多条消息 | `waitForIpcMessage` 合并后 context 取最后一条 | agent-runner 日志 |

## AC7: 向后兼容

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 7.1 | 旧版宿主（不发 context 字段）的 IPC 消息 | agent-runner 正常处理，不崩溃 | 手动写一个不含 context 的 IPC 文件，确认正常消费 |
| 7.2 | 记忆系统禁用时 | 不调用 `buildMessageContext()`，IPC 无 context | 设 memory disabled，发消息检查 IPC |

## AC8: 异常降级

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 8.1 | `buildMessageContext()` 抛异常（如 SQLite 锁） | context 降级为 null，消息正常发送 | 模拟异常，确认消息不丢 |
| 8.2 | context hash 缓存在 container 退出后被清除 | 新 session 首条消息能正常注入 context | 等 container 退出 → 重新发消息 → 检查 IPC |

## AC9: Token 预算

| # | 操作 | 预期结果 | 验证方法 |
|---|------|----------|----------|
| 9.1 | Wiki 命中 5+ 条 + 记忆 10+ 条 | 截断到 Wiki 3 条 + 记忆 5 条 | 构造高匹配场景，检查 context 条目数 |
| 9.2 | 单条 snippet 超 200 字 | 截断到 200 字 | 构造长 Wiki 条目，检查 snippet 长度 |

## 测试方法

### 层次 1：纯宿主侧验证（不需 container 消费）

验证 `buildMessageContext()` → IPC 文件写入链路。适用于开发阶段快速迭代。

```bash
# 通过 Debug API 发消息（container 不 active 时 IPC 文件不会被消费）
curl -X POST "http://127.0.0.1:19877/send?jid=fs:oc_xxx&text=Nine的Git工作流"

# 检查 IPC 文件内容
ls data/ipc/<group_folder>/input/*.json | xargs cat
# 预期：JSON 中包含 context.wiki 命中 nine-dev-workflow.md
```

**能验证**：AC2（动态注入）、AC3（去重）、AC4（无匹配）

### 层次 2：手动注入 IPC 文件验证 agent-runner

不依赖宿主侧，直接写 IPC 文件测试 agent-runner 三个入口。

```bash
# 构造带 context 的 IPC message
echo '{"type":"message","text":"你好","context":{"wiki":[{"title":"Nine开发规范","path":"nine-dev-workflow.md","snippet":"Git工作流: feat分支开发, PR合并到dev"}],"facts":[{"content":"测试记忆","category":"knowledge","confidence":0.5}]}}' \
  > data/ipc/<group_folder>/input/$(date +%s)-test.json

# 观察 agent 回复是否引用了 context 中的内容
```

**能验证**：AC6（三个 IPC 入口）、AC7（向后兼容——写不带 context 的文件）

### 层次 3：完整 E2E（飞书/Debug API → 回复）

```
飞书发消息 → NanoClaw 宿主 → buildMessageContext → IPC(with context)
  → agent-runner → formatContext → stream.push → agent 回复
```

**步骤**：

1. 先发一条消息触发冷启动，等 container active
2. 发"Nine 的 Git 工作流是什么" — 验证 Wiki 动态匹配
3. 发"飞书 E2E 怎么测" — 验证话题切换后 context 更新
4. 再问一遍"飞书 E2E" — 验证去重（第二条不注入）
5. 让 agent 记住新事实 → 等 5s → 发相关消息 → 验证新记忆召回

**关键验证点**：
- `nanoclaw.log` 中 `buildMessageContext` 匹配日志（wiki 标题 + facts 数量）
- `agent-runner` 日志中 `Piping IPC message` 后的 chars 长度变化（有 context 时更大）
- agent 回复内容是否引用了 context 中的 Wiki/记忆

### 层次 4：日志驱动验证

因为 IPC 文件被 agent-runner 秒删，需要在关键点加日志：

| 位置 | 日志内容 | 验证目的 |
|------|----------|----------|
| `src/index.ts` sendMessage 前 | `context: wiki=${titles.join(',')} facts=${count}` | 宿主侧匹配结果 |
| `src/index.ts` 去重判断后 | `context dedup hit/miss for ${group.folder}` | 去重机制 |
| `agent-runner drainIpcInput` | `IPC msg with context: wiki=${count} facts=${count}` | container 侧收到 |
| `agent-runner pollIpcDuringQuery` | `Piping with context: ${contextBlock.length} chars` | query 中追加 |
| `agent-runner waitForIpcMessage` | `Combined ${n} msgs, context from last` | 合并逻辑 |

## E2E 验收流程（手动）

1. 启动 NanoClaw，等待 container 冷启动完成
2. 发消息"Nine 的 Git 工作流是什么"→ 确认 agent 正确回答（冷启动注入）
3. 发消息"飞书 E2E 测试怎么做"→ 确认 agent 能引用新的 Wiki 内容（动态注入）
4. 发消息"你好"→ 确认无 `<context>` 注入
5. 让 agent 记住"测试事实：大杰喜欢冰美式"→ 等 5 秒 → 发"我的咖啡偏好"→ 确认回忆到
6. 等 30 分钟 container 超时 → 发消息 → 确认走冷启动路径，行为正常
