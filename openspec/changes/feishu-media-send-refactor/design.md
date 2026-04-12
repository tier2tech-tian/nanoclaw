## Context

飞书消息发送（`src/channels/feishu.ts`）当前有两个发送入口：
- `sendMessage(jid, text)` — agent 输出回调使用，包含进度卡片检测 + 媒体标记提取 + usage 脚注
- `sendDirectMessage(jid, text)` — IPC watcher 使用，仅调用 `sendPlainOrCard()`，完全不处理 `[图片:]` `[文件:]` 标记

历史演进导致媒体发送逻辑散布在 `sendMessage` 的三个 if 分支中（图片+文件混合、文件独立、普通文本），且 `sendImageMsg` 和 `sendFileMsg` 的路径解析逻辑不一致。这种碎片化结构导致了多个叠加 bug（路径拼接翻倍、文本卡片失败阻塞图片发送、`sendDirectMessage` 标记透传）。

## Goals / Non-Goals

**Goals:**
- 将媒体标记提取、路径解析、上传发送抽为独立私有方法，`sendMessage` 和 `sendDirectMessage` 共享
- 统一 `sendImageMsg` 和 `sendFileMsg` 的路径解析为单一函数 `resolveMediaPath()`
- 文本发送与媒体发送彻底解耦，任何一方失败不阻塞另一方
- 保持 `sendMessage` 的进度卡片检测、usage 脚注等现有逻辑不受影响

**Non-Goals:**
- 不改变进度卡片逻辑（createProgressCard / patch / cleanup）
- 不改变 `sendPlainOrCard` 的卡片/纯文本选择逻辑（仅增加降级）
- 不改变 IPC watcher 或 index.ts 中的调用方式
- 不增加新的消息类型或标记语法

## Decisions

### D1: 抽取 `extractAndSendMedia()` 方法

**选择**: 在 `FeishuChannel` 类中新增 `private async extractAndSendMedia(chatId, text, groupFolder, usage?, thinking?)` 方法。

**职责**:
1. 执行 `IMAGE_SEND_PATTERN` 和 `FILE_SEND_PATTERN` 正则匹配
2. 如果有匹配，strip 标记得到 `remainingText`
3. 发送 `remainingText`（独立 try-catch）
4. 逐个上传图片（独立 try-catch + 降级）
5. 逐个上传文件（独立 try-catch + 降级）
6. 如果无匹配，直接调用 `sendPlainOrCard()`

**替代方案**: 抽为独立模块文件 `src/channels/feishu-media.ts`。
**弃选原因**: 方法需要访问 `this.client`、`this.getTenantAccessToken()`、`this.sendPlainOrCard()` 等实例方法，抽为外部函数会需要传大量依赖。保持为类方法更简洁。

### D2: 统一路径解析函数 `resolveMediaPath()`

**选择**: 抽取 `private resolveMediaPath(inputPath, groupFolder): string` 纯函数，同时被 `sendImageMsg` 和 `sendFileMsg` 使用。

```
逻辑:
1. inputPath.startsWith('/workspace/group/') → strip + join(resolveGroupFolderPath(groupFolder), relative)
2. path.isAbsolute(inputPath) → 直接返回
3. 否则 → join(resolveGroupFolderPath(groupFolder), inputPath)
```

**当前问题**: `sendImageMsg` 已有三分支逻辑（容器路径/绝对路径/相对路径），但绝对路径分支额外要求 `fs.existsSync` 才走直接使用（否则降级为相对路径拼接）；`sendFileMsg` 只有两分支（容器路径/其他），非容器路径一律直接使用，不区分相对路径和绝对路径。两者行为不一致，且 `sendFileMsg` 缺少相对路径拼接逻辑。统一后消除不一致。

### D3: `sendDirectMessage` 复用提取逻辑

**选择**: `sendDirectMessage` 调用 `extractAndSendMedia()` 而非直接调用 `sendPlainOrCard()`。

```typescript
async sendDirectMessage(jid: string, text: string): Promise<void> {
  const chatId = chatIdFromJid(jid);
  const groupFolder = this.getGroupFolder(jid);
  await this.extractAndSendMedia(chatId, text, groupFolder);
}
```

**注意**: `sendDirectMessage` 不传 `usage` 和 `thinking`（IPC 消息不附加 usage 脚注，保持现有行为）。

### D4: 保持 `sendMessage` 结构不变

**选择**: `sendMessage` 中进度检测和 cleanup 逻辑不动，仅将媒体提取部分替换为 `extractAndSendMedia()` 调用。

```
sendMessage 重构后流程:
1. 进度消息检测 → 进度卡片（不变）
2. 清理进度卡片 + 读取 usage/thinking（不变）
3. extractAndSendMedia(chatId, text, groupFolder, usage, thinking) ← 替换原有 3 个 if 分支
```

## Risks / Trade-offs

**[Risk] sendDirectMessage 行为变更** → 之前 IPC 消息中的 `[图片:]` 标记被当文本发送，重构后会被提取为实际图片。这是期望行为，但需确认没有场景依赖旧的透传行为。Mitigation: grep 所有 IPC message 写入点确认。

**[Risk] groupFolder 为 null 时的行为** → 未注册群收到含标记的消息。Mitigation: `extractAndSendMedia` 在 groupFolder 为 null 时跳过媒体提取，记录 warn 日志，将原文本直接发送。

**[Risk] 正则 lastIndex 状态污染** → `IMAGE_SEND_PATTERN` 和 `FILE_SEND_PATTERN` 是全局正则（`/gi`），多次调用需重置 `lastIndex`。Mitigation: 在 `extractAndSendMedia` 入口处重置。

## Migration Plan

1. 实现 `resolveMediaPath()` 和 `extractAndSendMedia()`
2. 重构 `sendMessage` 使用新方法（替换 3 个 if 分支）
3. 重构 `sendDirectMessage` 使用新方法
4. `npm run build` 编译验证
5. 重启服务，发送图片/文件/混合消息验证
6. 检查日志确认无异常

**回滚**: 单文件修改，git checkout 即可回滚。

## Open Questions

无。方案明确，可直接实施。
