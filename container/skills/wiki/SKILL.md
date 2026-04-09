---
name: wiki
description: 全局共享 Wiki 知识库维护。Ingest 资料、Query 查询、Lint 健康检查。
---

# Wiki 知识库

全局共享知识库，所有群的 agent 共享。路径：`../../global/wiki/`

触发时机：
- 用户说"加到 wiki"、"整理到 wiki" → Ingest
- 用户发文件（`[文件: ...]`）且内容有知识价值 → 建议 Ingest 到 wiki
- 你为用户写了技术文档/方案/分析 → 建议存入 wiki
- 用户问问题且 wiki 可能有相关知识 → 先查 `../../global/wiki/index.md`
- 用户说"检查 wiki" → Lint

操作前先读 `INSTRUCTIONS.md`（与本文件同目录）获取详细指南。
