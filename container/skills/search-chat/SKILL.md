---
name: search-chat
description: 搜索聊天历史记录。当用户要求搜索聊天记录、查找对话、回顾历史消息时使用。
---

# Search Chat Skill

通过 MCP 工具搜索群组聊天历史，支持语义搜索（向量相似度）和关键词搜索（BM25）双路召回。

## 可用工具

- `mcp__nanoclaw__search_chat` — 搜索聊天历史记录。支持自然语言查询和关键词搜索。

## 何时使用

### 显式指令（必须响应）

| 用户说 | 你的动作 |
|--------|---------|
| "搜一下聊天记录" / "找一下之前的对话" | 调用 `search_chat` |
| "我们之前聊过 xxx" / "之前谁说过 xxx" | 调用 `search_chat` |
| "查一下历史消息" / "回顾一下" | 调用 `search_chat` |

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词或自然语言描述 |
| group | string | 否 | 限定搜索的群组 folder，默认当前群 |
| sender | string | 否 | 按发送人过滤 |
| days | number | 否 | 限定最近 N 天，默认 90 |
| limit | number | 否 | 返回条数，默认 10 |

## 搜索机制

- **向量搜索**：将 query 向量化后与 Qdrant 中的聊天 chunk 做余弦相似度匹配（权重 0.7）
- **关键词搜索**：使用 SQLite FTS5 trigram 分词做 BM25 匹配（权重 0.3）
- **融合排序**：加权合并 + 90 天时间衰减 + MMR 去重
- **降级模式**：Qdrant 不可用时自动退化为纯关键词搜索

## 已知限制

- 关键词搜索使用 trigram 分词，少于 3 个字符的查询无法通过关键词路径匹配
- 新消息入库有 5 秒 debounce 延迟
- 需要 `CHAT_INDEX_ENABLED=true` 环境变量开启
