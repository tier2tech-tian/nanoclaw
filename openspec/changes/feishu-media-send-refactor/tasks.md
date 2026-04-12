## 1. 路径解析统一

- [ ] 1.1 在 `FeishuChannel` 类中新增 `private resolveMediaPath(inputPath: string, groupFolder: string): string` 方法，统一三种路径格式解析
- [ ] 1.2 重构 `sendImageMsg` 使用 `resolveMediaPath()` 替换现有路径解析逻辑
- [ ] 1.3 重构 `sendFileMsg` 使用 `resolveMediaPath()` 替换现有路径解析逻辑

## 2. 媒体提取方法

- [ ] 2.1 新增 `private async extractAndSendMedia(chatId, text, groupFolder, usage?, thinking?)` 方法
- [ ] 2.2 实现标记提取：IMAGE_SEND_PATTERN + FILE_SEND_PATTERN 匹配和 strip（注意入口处重置 `lastIndex = 0`，strip 前也需重置）
- [ ] 2.3 实现发送流程：文本独立 try-catch → 图片逐个独立 try-catch → 文件逐个独立 try-catch
- [ ] 2.4 处理 groupFolder 为 null 的情况：跳过媒体提取，warn 日志，原文本直接发送

## 3. 入口重构

- [ ] 3.1 重构 `sendMessage()`：用 `extractAndSendMedia()` 替换三个 if 分支（图片+文件混合、文件独立、普通文本）
- [ ] 3.2 重构 `sendDirectMessage()`：调用 `extractAndSendMedia()` 替换直接 `sendPlainOrCard()`

## 4. 卡片降级

- [ ] 4.1 确认 `sendPlainOrCard()` 已有卡片失败降级纯文本逻辑（当前 session 已修复，验证编译产物一致）

## 5. 验证

- [ ] 5.1 `npm run build` 编译通过
- [ ] 5.2 重启服务，发送纯文本消息验证
- [ ] 5.3 发送 `[图片: /绝对路径]` 验证图片上传发送
- [ ] 5.4 发送 `[文件: /绝对路径]` 验证文件上传发送
- [ ] 5.5 发送混合消息（文本 + 图片 + 文件）验证
- [ ] 5.6 发送 Markdown 图片语法 `![描述](/path/to/img.png)` 验证 IMAGE_SEND_PATTERN 第二捕获组
- [ ] 5.7 通过 MCP send_message 工具发送含 `[图片:]` 标记的消息，验证 sendDirectMessage 路径
- [ ] 5.8 发送不存在路径的图片/文件，验证降级文本正确输出
- [ ] 5.9 检查日志确认无异常错误
