## Why

NanoClaw 的 runner 已能识别或接收到部分模型公开的 thinking/reasoning 内容，但主进程和飞书通道会主动丢弃，用户只能看到轮换占位词，无法了解 Agent 当前判断依据。Nine 已提供同类体验，NanoClaw 需要在不引入消息自循环和历史污染的前提下补齐。

## What Changes

- 从 Claude SDK、Claude print/interactive 和 Codex 的公开事件中提取可用 thinking/reasoning 内容；上游不提供时不生成替代内容。
- thinking 通过 Channel 的专用可选能力进入飞书进度卡，不经过普通消息发送路径。
- 飞书同一张过程卡新增默认折叠的“深度思考”面板，采用最新内容覆盖、脱敏和有界截断。
- 正式回复到达后拒绝迟到 thinking；完成卡保留最后一版面板，但不写入消息历史或过程记录。
- Gemini 当前事件流不提供 thinking，保持现状。

## Capabilities

### New Capabilities

- `feishu-thinking-progress`: 安全采集并在飞书同卡展示模型公开 thinking/reasoning 的行为契约。

### Modified Capabilities

无。

## Impact

- Runner：`container/agent-runner/src/index.ts`、`cli-runner.ts`、`sse-parser.ts`、`codex-runner.ts`。
- Host：`src/index.ts`、`src/types.ts`、`src/channels/feishu.ts`。
- 测试：runner 映射、host 分流、飞书卡片生命周期和字节边界。
- 无数据库、外部 API 或依赖变更；不支持该可选能力的 Channel 行为不变。
