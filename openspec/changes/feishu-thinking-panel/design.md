## Context

当前 `ContainerOutput` 已声明 `progressType: 'thinking'`，但 Claude SDK 明确跳过 thinking block，其他 runner 也没有统一映射；即使有旧 runner 产出，`src/index.ts` 与飞书 `sendMessage` 仍会分别过滤。过滤本身有历史原因：把 `💭` 当普通消息发出会被机器人再次消费并形成反馈循环，因此不能简单删掉过滤器。

飞书过程卡已有单卡状态、串行 patch 队列和终态锁。thinking 应成为独立的卡片展示状态，不进入 `steps/allSteps/progressPresentations`，从而避免污染过程记录和阶段语义。

## Goals / Non-Goals

**Goals:**

- 在所有确实暴露思考文本的 runner 中统一产出 thinking 进度。
- 只通过飞书同一张过程卡展示，默认折叠且最新覆盖。
- 守住脱敏、字节预算、迟到拒绝、单卡和无历史污染边界。
- 不支持 thinking 的 Channel 和运行模式保持原行为。

**Non-Goals:**

- 不推断、补写或要求模型额外生成思考内容。
- 不把 thinking 作为独立飞书消息、阶段步骤、过程记录或消息历史。
- 不承诺 Gemini 展示 thinking，除非其事件流未来提供正式字段。
- 不修改模型 thinking/effort 配置。

## Decisions

### 1. Channel 增加专用可选能力

在 `Channel` 增加 `updateThinking?(jid, text)`，host 对 `progressType=thinking` 只调用该能力；没有实现时直接忽略。相比给 `sendMessage` 增加标志位，这能从类型和调用路径上阻止普通 Channel 意外把 thinking 发成消息，也不需要按 `channel.name` 写特判。

### 2. Runner 在事件边界映射，不在 host 猜测

Claude SDK/print 从 assistant content 的 `thinking` block 提取，interactive SSE 支持 `thinking`/`thinking_delta`，Codex 仅接收带文本的 `reasoning` item。统一输出 `progressType=thinking`，正文放在 `detail`，短标题仅供兼容。Gemini 无正式字段，不改。

### 3. thinking 存在 ProgressCardEntry，不进步骤状态

在 `ProgressCardEntry` 保存 `thinkingText` 和截断状态，`buildProgressCard` 与完成卡构建时插入折叠面板。这样卡片创建等待、串行 patch、终态排空都复用现有生命周期；`allSteps` 和 progress session 不变，因此过程记录天然不含 thinking。

### 4. 纯函数负责安全渲染

新增纯函数完成脱敏、code point 限制、按转义后 UTF-8 字节截断和折叠面板构造。预算包含截断提示，避免提示本身把正文顶出限制。最终回复卡的总预算优先保障答案；thinking 使用独立较小预算。

### 5. 终态先锁再清状态

`progressDone` 或 entry `finalized` 任一成立即拒绝 thinking。完成构建从已锁定 entry 读取最后内容，patch 结束后随 entry 一起释放，不保留跨 turn Map，避免串轮。

## Risks / Trade-offs

- [SDK 可能分多块输出 thinking] → 每个公开 thinking block 独立映射，host 采用最新覆盖；不在 runner 拼接不同块的语义。
- [高频 thinking 导致 patch 放大] → 相同内容幂等跳过，并复用现有串行合并 patch 队列。
- [thinking 挤占飞书卡总预算] → 面板预算低于最终答案预算，终态构建继续使用现有整卡边界。
- [Codex reasoning item 形态变化] → 仅在 `type=reasoning` 且 `text` 为非空字符串时映射，否则忽略并保守兼容。
- [公开思考仍可能含敏感信息] → host 渲染前再次执行脱敏，不能只信 runner。

## Migration Plan

无数据迁移。先发布 runner 与 host 同一版本；旧 runner 仍无 thinking，新 runner 遇旧 host 会被现有过滤器丢弃，不会泄露。回滚代码即可恢复占位展示。

## Open Questions

无。Gemini 是否支持待其 CLI 提供稳定事件字段后另开变更。

## 测试计划

- **P0 纯逻辑**：Claude print、interactive SSE、Codex reasoning 映射；thinking 脱敏、Unicode/Markdown 字节预算、截断提示，总计约 10 例。
- **P0 生命周期**：起手卡同 message patch、最新覆盖、重复幂等、卡片创建竞态、终态保留、`progressDone/finalized` 迟到拒绝，总计约 8 例。
- **P1 分流**：host 只调用 `updateThinking`，不调用 `sendMessage`、不设置 `everSentToUser`、不写历史；不支持能力时忽略，总计约 4 例。
- **P1 回归**：现有进度卡、最终回复、其他 Channel 与 runner 测试；运行相关定向套件和 `npm run build`。
- **P2 真链路**：飞书发起一个能产生公开 thinking 的 Claude turn，核对仅一张卡、面板默认折叠、终态保留且无独立 thinking 消息。
