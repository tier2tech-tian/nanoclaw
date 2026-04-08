---
name: memory
description: 主动查询和存储用户记忆。当用户明确要求记住或回忆内容时使用。
---

# Memory Skill

你可以通过 MCP 工具主动读写记忆库。

## 可用工具

- `mcp__nanoclaw__memory_recall` — 搜索记忆。query 为空时返回全部。
- `mcp__nanoclaw__memory_remember` — 存储一条记忆。内容会先立即保存，后台异步经 LLM 标准化。

## 何时使用

### 显式指令（必须响应）

| 用户说 | 你的动作 |
|--------|---------|
| "记住：xxx" / "帮我记一下" | 调用 `memory_remember` |
| "你还记得 xxx 吗" / "查一下记忆" | 调用 `memory_recall` |
| "看看你都记了什么" | 调用 `memory_recall`（query 为空） |
| "搜一下关于 xxx 的记忆" | 调用 `memory_recall` |

## 与自动注入记忆的关系

- CLAUDE.md 中的记忆块是启动时自动注入的 top-K facts，覆盖了最相关的记忆。
- 如果需要更多上下文或搜索特定内容，使用 `memory_recall` 搜索完整记忆库。
- 使用 `memory_remember` 存储的内容立即生效，无需等待对话结束的自动提取。
- 过期记忆会通过时间衰减算法自动淘汰，无需手动删除。
