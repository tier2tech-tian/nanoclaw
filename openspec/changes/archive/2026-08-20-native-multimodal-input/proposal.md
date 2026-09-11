## Why

NanoClaw 目前把飞书图片下载到本地后降级为正文里的路径字符串，导致模型首次请求看不到图片，只能再逐张调用 `Read`，增加模型往返并割裂图文理解。Claude Agent SDK 已支持结构化用户消息，应让同一条飞书消息的文字和图片在第一次模型请求中一次送达，同时保持消息恢复和非 Claude runner 的兼容性。

## What Changes

- 为入站消息增加结构化附件元数据，并持久化图片本地路径、媒体类型、顺序和来源，不在数据库或日志中保存 base64。
- 飞书图片、富文本图片和合并转发图片在保留旧版本可读路径标记的同时写入结构化附件；Claude 原生组装时才在请求内把成功附带图片的路径替换为唯一标签。
- 冷启动任务与 active IPC 续聊统一携带附件；Claude SDK runner 将文字块和图片块组装成同一个 `SDKUserMessage`。
- Codex、Gemini、print 和 interactive runner 暂不新增原生图片协议，继续使用现有路径文本作为兼容降级。
- 图片缺失、格式不支持、数量或总大小超限时按单张降级为路径文本，不阻断同一条消息中的文字和其他有效图片。
- 增加脱敏结构化日志与 SDK 边界测试，确定性证明首轮原生携图、降级原因和旧实现反向失败。

## Capabilities

### New Capabilities

- `native-multimodal-input`: NanoClaw 入站图片的结构化持久化、跨进程传输、Claude SDK 首请求原生图文组装及兼容降级。

### Modified Capabilities

无。

## Impact

- 消息合同与持久化：`src/types.ts`、`src/db.ts`。
- 飞书入站解析：`src/channels/feishu.ts`。
- 消息编排与热会话 IPC：`src/index.ts`、`src/group-queue.ts`。
- runner 输入与 Claude SDK 消息流：`src/container-runner.ts`、`container/agent-runner/src/index.ts`。
- 测试：数据库迁移、飞书富文本、附件选择/降级、冷启动和 active IPC、SDK content blocks、真实飞书 E2E。
- 不修改 Nine，不引入新 npm 依赖，不改变纯文本消息和非 Claude runner 的现有行为。
