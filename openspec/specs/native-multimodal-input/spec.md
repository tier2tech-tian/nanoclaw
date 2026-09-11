# native-multimodal-input Specification

## Purpose
TBD - created by archiving change native-multimodal-input. Update Purpose after archive.
## Requirements
### Requirement: 入站图片保持结构化身份
系统 MUST 将成功下载的入站图片作为结构化附件关联到原消息，并持久化附件类型、本地路径、显示序号与来源；消息正文 MUST 继续保存旧版本可识别的兼容路径标记，且数据库、IPC 和日志 MUST NOT 保存图片 base64。

#### Scenario: 飞书富文本包含多张图片
- **WHEN** 一条飞书富文本消息包含文字和三张成功下载的图片
- **THEN** 系统保存一条文字消息和三个有序图片附件，并在正文中保留旧版本可读取的三个图片路径标记

#### Scenario: 进程重启后恢复未处理图文消息
- **WHEN** 图文消息入库后主进程在投喂模型前重启
- **THEN** 系统从数据库恢复文字和全部附件元数据，并继续按原顺序投喂

#### Scenario: 敏感负载不落库
- **WHEN** 系统准备把本地图片编码为模型可接受的 base64
- **THEN** base64 仅存在于 runner 的请求组装阶段，不写入消息表、IPC 文件或结构化日志

### Requirement: Claude 首次请求原生携带图文
系统 SHALL 在 Claude SDK 模式下，把本轮所有有效图片与格式化文字组装进同一个 `SDKUserMessage`；每张图片 MUST 使用批次内唯一的“消息序号-图片序号”文字标签，且成功原生附带的图片 MUST NOT 再向模型暴露可供 `Read` 的路径标记。

#### Scenario: 冷启动收到单条图文消息
- **WHEN** 群内没有活跃 runner，用户发送一条文字加三张有效图片的飞书消息
- **THEN** 新 runner 的第一条用户消息同时包含格式化文字和三个 image content block，不需要后续 `Read` 才能看到图片

#### Scenario: 多条待处理消息包含图片
- **WHEN** 一次批处理包含多条用户消息且其中多条带图片
- **THEN** 系统按消息顺序和附件顺序生成批次内唯一标签，并让每个标签紧邻对应 image block，使模型可以把图片归属到对应消息

#### Scenario: SDK 边界确定性验收
- **WHEN** 测试替身直接消费传给 `query()` 的 `AsyncIterable<SDKUserMessage>`
- **THEN** 第一次 `next()` 恰好得到一条同时含格式化文字和全部有效 image blocks 的用户消息，图片不会被拆成后续消息

### Requirement: active IPC 续聊与冷启动一致
系统 MUST 在已有活跃 Claude runner 时，通过 IPC 传输同一份结构化附件元数据，并把文字和图片作为一个后续 `SDKUserMessage` 推入当前会话。

#### Scenario: 活跃会话收到图文续聊
- **WHEN** 用户在 Agent 正执行时发送一条文字加图片的消息
- **THEN** IPC 文件包含文字和附件元数据，runner 一次 push 产生同时含文字和图片的后续用户消息

#### Scenario: IPC 消息被合并
- **WHEN** 同一轮轮询读取多个待合并 IPC 文件
- **THEN** 系统合并文字时同时保留各文件附件及其确定顺序，不丢失或重复图片

#### Scenario: active IPC 沿用现有投递语义
- **WHEN** 主进程已将图文 IPC 文件交给活跃 runner
- **THEN** 附件与文字遵循当前文本 IPC 相同的 at-most-once 投递语义，不额外承诺 runner 崩溃窗口内的重放

### Requirement: 安全验证与逐图降级
runner MUST 只读取允许工作区内的图片路径，通过文件签名识别 JPEG、PNG、GIF 或 WebP，并对原生图片数量、单图 base64 大小和总 base64 大小实施上限；任一图片不满足条件时 MUST 仅降级该图片为路径文本，不阻断文字和其他有效图片。

#### Scenario: 图片文件缺失
- **WHEN** 附件元数据指向的图片在 runner 组装请求时已不存在
- **THEN** 系统记录不含图片内容的降级原因，并在文字中保留该图片的路径提示供 Agent 决定后续处理

#### Scenario: 图片格式不受支持
- **WHEN** 文件扩展名看似图片但文件签名不是 JPEG、PNG、GIF 或 WebP
- **THEN** 系统不构造 image content block，并把该附件降级为路径文本

#### Scenario: 图片超过原生传输预算
- **WHEN** 某张图片或本轮累计图片超过配置的原生传输上限
- **THEN** 系统按原顺序原生附带预算内图片，并将超限图片逐张降级为路径文本

#### Scenario: 附件路径越界
- **WHEN** 附件路径不在当前群工作区允许目录内
- **THEN** 系统拒绝读取文件、不在提示词中泄露可用路径，并记录脱敏告警

### Requirement: 非 Claude runner 保持兼容
系统 MUST 保持 Codex、Gemini、print 和 interactive 模式的现有文本输入合同；这些模式接收带图片的消息时 SHALL 使用正文中已有的可读路径标记，不尝试发送 Claude image content block。

#### Scenario: Codex 模式收到图文消息
- **WHEN** 群配置为 Codex runner 且收到图文消息
- **THEN** runner 收到与旧行为兼容的文字和图片路径，不发生序列化错误或图片丢失

#### Scenario: 其他非原生模式收到图文消息
- **WHEN** 群配置为 Gemini、print 或 interactive runner 且收到图文消息
- **THEN** runner 继续收到与旧行为相同的文字和图片路径，附件对象不会进入不支持的厂商协议

### Requirement: 重试保持同一附件合同
系统 MUST 在 Claude 冷启动的瞬时 API 错误重试和账号轮换重试中传递同一组附件元数据，并在每次新请求组装时重新验证文件，不静默丢图或重复图片块。

#### Scenario: 首次请求后发生瞬时错误重试
- **WHEN** 带三张图片的 Claude 请求因可重试 5xx 或账号限流进入现有重试链路
- **THEN** 重试请求仍在第一条用户消息中包含同样三个图片标签和三个 image blocks

### Requirement: 可观测性证明首轮携图
系统 SHALL 记录每轮原生附带、降级和跳过的图片数量及脱敏原因，不记录绝对路径或 base64，以便 E2E 证明图文已在首请求合并。

#### Scenario: 三图全部原生附带
- **WHEN** Claude runner 成功组装一条包含三张图片的用户消息
- **THEN** 日志包含 `native=3`、`fallback=0` 的结构化统计，且不包含图片 base64 和绝对路径
