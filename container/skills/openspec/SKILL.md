---
name: openspec
description: 使用 OpenSpec CLI 管理变更规范。当用户要求写规范、写 spec、写 openspec、写设计文档、写方案文档时触发。触发词包括：openspec、写规范、写 spec、设计文档、方案文档、变更提案。
---

# OpenSpec 变更规范

使用 `openspec` CLI 工具进行 spec-driven 开发。工作流：proposal → specs → design → tasks。

触发时机：
- 用户说"写 openspec"、"写规范"、"写 spec" → 创建新 change
- 用户说"看下 openspec"、"有哪些 spec" → 列出/查看
- 用户说"更新 spec" → 更新现有 change

操作前先读 `INSTRUCTIONS.md`（与本文件同目录）获取 CLI 用法和工作流指南。
