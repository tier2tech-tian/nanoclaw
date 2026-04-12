## ADDED Requirements

### Requirement: 统一媒体标记提取入口

所有发往飞书的消息（无论通过 `sendMessage` 还是 `sendDirectMessage`）在实际发送前 SHALL 经过统一的媒体标记提取处理。提取方法 `extractAndSendMedia(chatId, text, groupFolder, usage?, thinking?)` 负责：
1. 从文本中识别 `[图片:]` / `[文件:]` 标记
2. 提取路径列表
3. 从文本中移除已提取的标记
4. 返回处理后的纯文本和待发送的媒体列表

#### Scenario: sendMessage 调用提取（标记语法）
- **WHEN** `sendMessage(jid, text)` 收到包含 `[图片: /path/to/img.png]` 的文本
- **THEN** 系统 SHALL 提取图片路径，发送剩余文本为卡片/纯文本，然后上传并发送图片

#### Scenario: sendMessage 调用提取（Markdown 图片语法）
- **WHEN** `sendMessage(jid, text)` 收到包含 `![描述](/path/to/img.png)` 的文本
- **THEN** 系统 SHALL 按 IMAGE_SEND_PATTERN 的 Markdown 图片捕获组提取路径，行为与 `[图片:]` 标记一致

#### Scenario: sendDirectMessage 调用提取
- **WHEN** `sendDirectMessage(jid, text)` 收到包含 `[文件: /path/to/file.pdf]` 的文本
- **THEN** 系统 SHALL 提取文件路径，发送剩余文本为纯文本，然后上传并发送文件（与 sendMessage 行为一致）

#### Scenario: 无标记时透传
- **WHEN** 文本不包含任何 `[图片:]` 或 `[文件:]` 标记
- **THEN** 系统 SHALL 直接调用 `sendPlainOrCard()` 发送原文本，不做额外处理

---

### Requirement: 文本发送与媒体发送解耦

文本卡片发送失败 SHALL NOT 阻塞后续的图片/文件上传和发送。每个媒体文件的发送也 SHALL 独立，单个失败不影响其他文件。

#### Scenario: 文本卡片失败但图片成功
- **WHEN** 剩余文本通过 `sendPlainOrCard()` 发送失败（如飞书 API 返回 `invalid image keys`）
- **THEN** 系统 SHALL 记录 warn 日志，继续上传并发送后续图片/文件

#### Scenario: 部分图片失败
- **WHEN** 文本中有 3 张图片标记，第 2 张上传失败
- **THEN** 第 1 张和第 3 张 SHALL 正常发送，第 2 张降级为文本 `[图片发送失败: /path]`

#### Scenario: 降级文本也失败
- **WHEN** 图片上传失败后降级文本 `[图片发送失败: /path]` 发送也失败
- **THEN** 系统 SHALL 静默跳过（不抛异常），继续处理后续媒体

---

### Requirement: 统一路径解析

`sendImageMsg` 和 `sendFileMsg` SHALL 使用相同的路径解析策略，消除两者之间的不一致。

#### Scenario: 容器路径解析
- **WHEN** 路径以 `/workspace/group/` 开头
- **THEN** 系统 SHALL strip 前缀，拼接 `resolveGroupFolderPath(groupFolder)` 得到宿主机路径

#### Scenario: 宿主机绝对路径
- **WHEN** 路径是绝对路径（以 `/` 开头）且不以 `/workspace/group/` 开头
- **THEN** 系统 SHALL 直接使用该路径，不做拼接

#### Scenario: 相对路径
- **WHEN** 路径不以 `/` 开头
- **THEN** 系统 SHALL 拼接 `resolveGroupFolderPath(groupFolder)` + 路径

#### Scenario: groupFolder 为 null
- **WHEN** 消息所属群未注册（groupFolder 为 null）
- **THEN** 系统 SHALL 跳过媒体提取，将原文本（含标记）直接作为文本发送，并记录 warn 日志

#### Scenario: 文件不存在
- **WHEN** 路径解析完成后目标文件不存在（`fs.existsSync` 返回 false）
- **THEN** `sendImageMsg` / `sendFileMsg` SHALL 抛出异常，由 `extractAndSendMedia` 的独立 try-catch 捕获并降级为文本 `[图片发送失败: /path]` 或 `[文件发送失败: /path]`

---

### Requirement: 卡片发送降级

`sendPlainOrCard()` 在卡片模式（`msg_type: 'interactive'`）发送失败时 SHALL 自动降级为纯文本（`msg_type: 'text'`）。

#### Scenario: 卡片 API 返回 invalid image keys
- **WHEN** 飞书 Card API 返回错误码 230099 或 200570（`invalid image keys`）
- **THEN** 系统 SHALL 记录 warn 日志，重新以 `msg_type: 'text'` 发送相同内容

#### Scenario: 卡片其他错误
- **WHEN** 飞书 Card API 返回其他错误
- **THEN** 系统 SHALL 同样降级为纯文本发送（不区分错误类型）

#### Scenario: 纯文本降级也失败
- **WHEN** 降级后纯文本发送也失败
- **THEN** 系统 SHALL 抛出异常，由调用方决定处理方式
