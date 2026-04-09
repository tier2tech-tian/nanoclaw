# Wiki 操作详细指南

基于 Karpathy LLM Wiki 模式的全局共享知识库。

## 目录结构

```
groups/global/wiki/       ← Wiki 页面（LLM 维护）
groups/global/wiki/index.md  ← 全局索引
groups/global/wiki/log.md    ← 操作日志
groups/global/sources/    ← 原始资料（不可变）
```

从 agent 工作区访问：`../../global/wiki/` 和 `../../global/sources/`

## Ingest（导入资料）

用户提供文档、URL、或让你写技术方案时：

1. 把原始资料存到 `sources/`（URL 用 curl 下载，文本直接写文件）
2. 通读资料，提取关键信息
3. 创建或更新 wiki 页面：
   - 该资料的摘要页（`wiki/sources/xxx.md`）
   - 相关实体页（项目、人员、技术）
   - 相关概念页
4. 更新所有受影响页面的交叉引用（用 `[[page-name]]` wiki link 格式）
5. 更新 `wiki/index.md`
6. 追加 `wiki/log.md` 条目

**重要**：多个资料必须逐一处理，不要批量。

## Query（查询）

1. 先读 `wiki/index.md` 找相关页面
2. 读取相关 wiki 页面
3. 基于已综合的知识回答（附引用）
4. 如果回答本身有价值，考虑存回 wiki 作为新页面

## Lint（健康检查）

- 检查页面间矛盾
- 找孤立页面（无入链）
- 找过时内容
- 找缺失交叉引用
- 建议需要补充的内容

## 页面格式

```markdown
# 页面标题

简要描述。

## 内容

正文内容，使用 [[other-page]] 交叉引用。

## 相关

- [[related-page-1]]
- [[related-page-2]]

---
*来源: source-file.md | 创建: 2026-04-09 | 更新: 2026-04-09*
```
