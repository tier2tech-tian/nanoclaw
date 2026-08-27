## ADDED Requirements

### Requirement: 仅展示上游公开的思考内容
系统 SHALL 仅展示模型运行时通过 thinking 或 reasoning 事件公开提供的内容，SHALL NOT 从工具调用、最终答案或 token 数量推测思考文本；上游不提供时 SHALL 保持现有占位展示。

#### Scenario: Claude 提供 thinking block
- **WHEN** Claude SDK、print 或 interactive 流产生非空 thinking block
- **THEN** runner SHALL 输出 `progressType=thinking` 的结构化进度，并保留有界正文

#### Scenario: Codex 提供 reasoning summary
- **WHEN** Codex JSONL 产生带非空文本的 reasoning item
- **THEN** runner SHALL 将公开摘要映射为 thinking 进度，而不是工具调用进度

#### Scenario: 上游没有思考内容
- **WHEN** Gemini 或其他运行模式没有提供 thinking/reasoning 文本
- **THEN** 系统 SHALL NOT 伪造内容，飞书卡 SHALL 继续显示现有状态标题

### Requirement: 思考内容不走普通消息链路
thinking 进度 SHALL 仅通过 Channel 的专用可选能力传递，SHALL NOT 调用普通 `sendMessage`，SHALL NOT计为已向用户发送正式内容，SHALL NOT写入消息历史或过程记录。

#### Scenario: 飞书支持 thinking 进度
- **WHEN** host 收到 thinking 进度且当前 Channel 实现专用能力
- **THEN** host SHALL 调用该专用能力更新卡片，并立即结束本条进度处理

#### Scenario: Channel 不支持 thinking 进度
- **WHEN** host 收到 thinking 进度但当前 Channel 未实现专用能力
- **THEN** host SHALL 安全忽略，不得降级为普通消息

### Requirement: 飞书同卡折叠展示
飞书 SHALL 在当前过程卡内展示默认折叠的“深度思考”面板；同一 turn 的新 thinking SHALL 覆盖旧内容而非追加消息或步骤。

#### Scenario: 起手卡收到首条 thinking
- **WHEN** 当前 turn 已有起手卡且收到首条非空 thinking
- **THEN** 系统 SHALL 原地 patch 同一 message，并在标题后加入默认折叠面板

#### Scenario: thinking 先于卡片创建完成
- **WHEN** thinking 到达时进度卡尚未创建或 message ID 仍在等待
- **THEN** 系统 SHALL 保存最新内容，并在卡片可用后统一渲染，不得额外创建第二张卡

#### Scenario: 重复或更新 thinking
- **WHEN** 收到与当前内容相同的 thinking
- **THEN** 系统 SHALL 跳过无意义 patch；内容变化时 SHALL 只保留最新版本

### Requirement: 展示内容安全且有界
thinking 文本 SHALL 复用进度展示脱敏规则，按 code point 和转义后 UTF-8 字节双重限制；面板正文和截断提示合计 SHALL 不超过既定面板预算。

#### Scenario: 内容包含敏感值
- **WHEN** thinking 含凭证、内部地址或其他既有脱敏规则可识别内容
- **THEN** 卡片 SHALL 只展示脱敏后的文本

#### Scenario: 内容超过预算
- **WHEN** thinking 经飞书 Markdown 转义后超过面板预算
- **THEN** 系统 SHALL 在预算内截断并显示“内容已截断”提示，卡片仍可成功 patch

### Requirement: 终态拒绝迟到并保留最后内容
正式回复或清理开始后，系统 SHALL 拒绝迟到 thinking 覆盖终态；存在过程卡时，终态卡 SHALL 保留最后一版 thinking 折叠面板。

#### Scenario: 正式回复后 thinking 迟到
- **WHEN** `progressDone` 已标记或进度 entry 已 finalized 后收到 thinking
- **THEN** 系统 SHALL 忽略该事件，SHALL NOT 新建或 patch 卡片

#### Scenario: 完成卡保留 thinking
- **WHEN** turn 完成前已有 thinking 和可保留的过程卡
- **THEN** 完成卡 SHALL 保留最后一版折叠面板，且最终答案优先于 thinking 占用卡片预算
