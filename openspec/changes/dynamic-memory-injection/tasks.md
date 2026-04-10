# Dynamic Memory Injection — Tasks

## 1. 宿主侧：抽取共享底层函数 + buildMessageContext()

- [ ] 1.1 从 `src/memory/inject.ts` 中抽取 `extractKeywords(text): string[]` 为独立导出函数
- [ ] 1.2 从 `src/memory/inject.ts` 中抽取 `matchWikiEntries(text, wikiDir): WikiMatch[]` 为独立导出函数
- [ ] 1.3 从 `src/memory/inject.ts` 中抽取 `recallRelevantFacts(text, userId?, topK?): Promise<FactMatch[]>` 为独立导出函数
- [ ] 1.4 实现 `buildMessageContext(text, userId): Promise<MessageContext | null>`，组合 1.1-1.3
- [ ] 1.5 重构 `injectMemory()` 内部复用 1.1-1.3 的共享函数（不调用 `buildMessageContext`），确保冷启动路径行为不变
- [ ] 1.6 定义 `MessageContext`、`WikiMatch`、`FactMatch` TypeScript 接口（`src/memory/inject.ts`）

## 2. 宿主侧：消息预处理集成

- [ ] 2.1 在 `src/index.ts` 的 container active 分支（第 933-935 行之间），调用 `buildMessageContext()` 获取 context（异步）
- [ ] 2.2 实现 per-group context hash 去重（`lastContextHash: Map<string, string>`），放在 `src/index.ts` 模块级
- [ ] 2.3 container 退出时清除该 group 的 hash 缓存（`runForGroup` finally 块或 GroupQueue reset 回调）
- [ ] 2.4 `buildMessageContext()` 异常时 try-catch 降级为 `context = null`，不阻塞消息发送

## 3. 宿主侧：sendMessage 透传 context

- [ ] 3.1 修改 `GroupQueue.sendMessage()` 签名，新增 optional `context?: MessageContext | null` 参数
- [ ] 3.2 `sendMessage()` 内部 `JSON.stringify` 时将 context 写入 IPC payload
- [ ] 3.3 `src/index.ts` 调用处传入 context 参数

## 4. Container 侧：IpcMessage 接口 + drainIpcInput

- [ ] 4.1 `IpcMessage` 接口新增 `context?: MessageContext | null` 字段
- [ ] 4.2 在 container 侧定义 `MessageContext`、`WikiMatch`、`FactMatch` 接口（与宿主侧相同）
- [ ] 4.3 `drainIpcInput()` 第 370-371 行，解析 `data.context` 到 IpcMessage 对象

## 5. Container 侧：三个消费入口处理 context

- [ ] 5.1 实现 `formatContext(ctx: MessageContext): string`，格式化为 `<context>` XML 块
- [ ] 5.2 `pollIpcDuringQuery()` 第 474 行：`stream.push()` 前检查 `msg.context`，非空时 prepend `<context>` 块
- [ ] 5.3 `waitForIpcMessage()` 合并逻辑（第 404-407 行）：合并后 context 取最后一条消息的
- [ ] 5.4 初始 prompt 拼接（第 1029-1032 行）：pending 消息带 context 时 prepend 到各自 text 前
- [ ] 5.5 处理边界情况：context 为 null / 空数组 / wiki 有但 facts 无

## 6. Token 预算控制

- [ ] 6.1 `buildMessageContext()` 内截断：Wiki top 3（snippet ≤200 字）+ 记忆 top 5（content ≤100 字）
- [ ] 6.2 总 context 超预算时按优先级截断（中文字符按 1.5-2 tokens/字估算，预留余量）

## 7. 测试验证

- [ ] 7.1 单元测试：`buildMessageContext()` 正确返回 Wiki + 记忆匹配结果
- [ ] 7.2 单元测试：context hash 去重逻辑（含 container 退出后 hash 清除）
- [ ] 7.3 单元测试：`formatContext()` 输出格式正确（含 wiki-only、facts-only、混合场景）
- [ ] 7.4 单元测试：`waitForIpcMessage()` 合并多条消息时 context 取最后一条
- [ ] 7.5 集成测试（宿主侧）：发消息 → IPC 文件包含正确 context payload
- [ ] 7.6 集成测试（container 侧）：IPC 文件消费后 prompt 包含 `<context>` 块
- [ ] 7.7 E2E 测试：通过 Debug API 验证动态注入后 agent 能感知最新 Wiki/记忆
