## Why

飞书消息发送中的文件/图片提取逻辑散落在 `sendMessage()` 的多个分支中，且 `sendDirectMessage()` 完全跳过了标记提取，导致通过 IPC/MCP 路径发送的消息中 `[文件:]` `[图片:]` 标记被当成文本发出。加上路径拼接、卡片发送异常阻塞等叠加 bug，图片/文件发送呈现"时好时坏"的状态，排查困难。

## What Changes

- 将 `[图片:]` / `[文件:]` 标记提取、路径解析、上传发送逻辑从 `sendMessage()` 中抽离为独立方法 `extractAndSendMedia()`
- `sendDirectMessage()` 复用同一提取逻辑，不再跳过标记处理
- 统一路径解析策略：容器路径 `/workspace/group/xxx`、宿主机绝对路径、相对路径统一处理，消除 `sendImageMsg`（三分支 + existsSync 前置判断）与 `sendFileMsg`（两分支，不区分相对/绝对）之间的不一致
- 文本卡片发送失败不阻塞后续图片/文件发送（独立 try-catch）
- `sendPlainOrCard()` 卡片失败自动降级纯文本
- **BREAKING**: `sendDirectMessage()` 将不再是纯透传，会提取并处理媒体标记

## Capabilities

### New Capabilities
- `media-extraction`: 统一的媒体标记提取与发送模块，负责从文本中识别 `[图片:]` `[文件:]` 标记、解析路径、上传文件、发送消息，并处理所有错误降级

### Modified Capabilities
<!-- 无现有 spec 需要修改 -->

## Impact

- **核心文件**: `src/channels/feishu.ts` — `sendMessage()`, `sendDirectMessage()`, `sendPlainOrCard()`, `sendImageMsg()`, `sendFileMsg()` 全部受影响
- **调用方**: `src/index.ts`（agent output callback, IPC watcher）、`src/ipc.ts`（IPC message handler）无需修改，行为通过 channel 方法自动继承
- **风险**: 进度卡片逻辑不受影响（在 `sendMessage` 中进度检测在媒体提取之前，不涉及此重构）
- **测试**: 需覆盖：纯文本、图片标记、文件标记、混合标记、容器路径、绝对路径、卡片降级、上传失败降级等场景
