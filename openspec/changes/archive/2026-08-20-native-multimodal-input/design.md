## Context

飞书适配器当前把图片下载到群目录后，将 `[图片: 绝对路径]` 拼进 `NewMessage.content`。`messages` 表、`formatMessages`、`GroupQueue.sendMessage`、IPC JSON、`ContainerInput.prompt` 和 `MessageStream.push` 都只接受字符串，因此图片在进入消息总线时就失去结构化身份。真实日志已证明，同一条文字加三图的飞书消息只触发一个 Agent query，但模型需要额外发起三次 `Read` 才能看到图片。

Claude Agent SDK 0.3.201 的 `query` 接受 `AsyncIterable<SDKUserMessage>`，其 `MessageParam.content` 可使用文本和图片 content blocks。Claude API 当前接受 JPEG、PNG、GIF、WebP 的 base64 图片，直接 API 单图上限为 10 MB，部分兼容后端为 5 MB，标准请求总上限为 32 MB；本实现采用更保守的 5 MB 单图 base64、20 MB 单轮 base64 和 5 图上限，并对超限图片保留旧路径降级。

## Goals / Non-Goals

**Goals:**

- 同一轮飞书文字和图片在 Claude SDK 的第一条用户消息中一次送达。
- 冷启动、重启恢复和 active IPC 续聊共享同一附件合同。
- base64 只在 runner 内即时生成，不进入 DB、IPC 或日志。
- 单图失败时局部降级，不拖垮整条文字消息和其他有效图片。
- 保持纯文本与非 Claude runner 行为兼容。

**Non-Goals:**

- 本变更不修改 Nine，也不为 Codex/Gemini 新增厂商特定视觉协议。
- 不引入图片压缩、缩放、OCR、远端对象存储或 Files API。
- 不让历史上只有路径字符串、没有附件元数据的旧消息自动升级为原生图文。
- 不改变飞书图片下载上限和图片生命周期清理策略。

## Decisions

### 1. 在消息边界增加附件，而不是解析路径字符串

新增 `MessageAttachment`，`NewMessage.attachments` 保持运行时结构，`messages.attachments_json` 保存 JSON 数组。飞书适配器在下载成功时继续把旧版 `[图片: path]` 标记写入正文，同时生成结构化附件；数据库读取时严格解析，非法 JSON 降级为空数组并告警。

不采用“在 runner 用正则扫描 `[图片: path]`”的方案，因为它把展示文本继续当协议，无法可靠区分用户原文、文件附件和系统生成路径，也不能对重启恢复、路径安全和多 runner 行为建立稳定合同。

### 2. 正文继续保存兼容路径，Claude builder 只在请求内替换

新消息正文继续使用现有 `[图片: path]`，保证旧版本回滚和非 Claude runner 可读。飞书当前所有下载图片标记都按附件顺序追加在单条 `NewMessage.content` 尾部；Claude builder MUST 在 XML 转义和批次拼接之前，按该消息自己的附件逆序剥离完全匹配的尾部标记，再根据校验结果重建正文：成功附件生成批次内唯一的 `[消息 M-图片 N，已随消息附上]`，降级附件恢复原路径标记。禁止扫描或全局替换最终 prompt；若尾部与结构化附件不完全匹配，则该附件整体降级，不猜测替换位置。每个成功标签文本块紧邻对应 image block。

这样既避免成功原生携图后模型仍被路径诱导去 `Read`，也不会误改用户正文中自己输入的伪造标记；路径包含 `&`、`<` 等字符时也在替换完成后统一 XML 转义。发布后回滚旧二进制时，尚未处理的消息仍能按旧逻辑读取图片。旧消息没有附件元数据，继续按原路径文本处理。

### 3. 主进程传元数据，runner 读文件并编码

`ContainerInput` 和 active IPC JSON 新增附件数组，只传本地路径与标签，不传文件内容。runner 在构造 `SDKUserMessage` 前执行路径校验、文件签名识别、预算判断和 base64 编码。

把编码放在 runner 而不是飞书适配器或主进程，可缩短敏感大字符串生命周期，避免 DB/IPC 膨胀，并让安全校验贴近真正读文件的位置。

### 4. I/O 校验与纯组装分层

I/O 层 `loadValidatedImage` 负责受控打开、文件属性/签名检查和 base64 编码；纯函数负责估算 `4 * ceil(rawBytes / 3)`、预算选择、唯一标签排序和 content blocks 组装。`MessageStream.push` 接受已构造的 `SDKUserMessage` content，而不是固定 `string`。冷启动调用与 IPC follow-up 都调用同一构建入口，防止两条路径漂移。

图片类型只信文件签名：JPEG `FF D8 FF`、PNG 标准签名、GIF87a/GIF89a、WebP `RIFF....WEBP`。路径先对允许根和目标执行 `realpath` containment，再以 `O_NOFOLLOW` 打开最终文件并 `fstat` 确认普通文件；编码前按 fd 实际大小预估 base64，串行读取，禁止 `Promise.all`。扩展名和上游 MIME 仅作展示信息，不作为安全判定。

### 5. 有序合并附件，不做全有或全无

主进程从 `messagesToSend` 按消息顺序展开附件，并为每个附件带上消息 ID 和显示标签。IPC drain 合并多个文件时按文件名顺序连接附件。runner 依次消费预算：有效且预算内的转为 image block，其余生成降级文本。

局部降级能保证一张坏图不会让三张好图和正文全部退回旧路径，也避免模型请求因单个非法 image block 整体失败。

### 6. 数据库迁移采用幂等列探测

在 `createSchema` 中通过 `PRAGMA table_info(messages)` 判断后执行 `ALTER TABLE messages ADD COLUMN attachments_json TEXT`，而不是依赖吞异常。新列可空，旧版本回滚会忽略该列；旧消息读取为空附件。

### 7. active IPC 不在本变更升级可靠性语义

结构化附件与文字进入同一 IPC JSON，并沿用当前 SDK drain 和 interactive inflight 机制。普通 SDK active IPC 目前是 at-most-once：主进程写入后推进 cursor，runner drain 后删除文件；本变更保证附件不比文字更早丢失或被拆开，但不顺手引入通用 ack/requeue 状态机。该既有崩溃窗口应另立可靠性任务处理，否则会把一次图文输入改造扩大成整个消息投递协议重写。

### 8. SDK 边界捕获是发布主门禁

测试在 `query()` 边界注入 fake，直接消费传入的 `AsyncIterable`。三图用例必须证明第一次 `next()` 仅产生一条 `SDKUserMessage`，该消息同时含格式化文字和三个 image blocks；把实现恢复为 `stream.push(string)`、删除 image block 或拆成多条消息时测试必须变红。真实飞书 E2E 的“模型未调用 Read”只作观察证据，不作为唯一正确性证明。

## Risks / Trade-offs

- [图片 base64 增加请求延迟和内存峰值] → 采用 5 图、单图 5 MiB base64、总计 20 MiB base64 的保守预算；编码前按原始字节精确估算，基于 fd 二次校验并串行编码。最终 content blocks 持有的 base64 仍会增加内存，这是换取首请求视觉输入的明确成本；超限走路径降级。
- [SDK 或兼容后端拒绝合法图片] → 只允许官方四种格式，并保留单图路径降级；E2E 使用当前生产同款 SDK/账号链路验证。
- [active IPC 与冷启动再次漂移] → 两条入口只负责传附件，最终统一调用同一个 content builder，并用同一组契约测试反向变异。
- [绝对路径或 base64 泄露到日志] → 成功原生图片只向模型显示标签；新增统计仅记数量和枚举原因；debug agent input 日志对附件、图片路径标记和任何 base64 字段统一脱敏，飞书下载日志不再记录完整 `hostPath`。仅降级到旧行为时才把已校验的群内路径给 Agent。
- [DB JSON 被手工或旧代码写坏] → 严格解析、过滤未知字段并降级为空；正文仍可正常处理。
- [本地 main 比 origin/main 多两个工作流提交] → worktree 明确基于当前已使用的本地主线，PR 前核对 diff，只提交本功能相关文件。

## Migration Plan

1. 上线时幂等增加 `messages.attachments_json`，不回填历史数据。
2. 同一版本同时接通附件读写和 Claude SDK content blocks；消息正文始终保留旧路径合同，因此旧二进制回滚可继续处理新版本尚未消费的消息。
3. 新消息开始写结构化附件；旧消息和非 Claude runner 保持旧行为。
4. 回滚旧版本时新增列保留但被忽略，正文路径仍可按旧逻辑处理；无需 down migration。发布前仍必须完成 SDK 边界确定性测试与真链路 E2E。

## Open Questions

无阻塞问题。图片压缩与 Codex/Gemini 原生视觉作为后续独立变更处理。

## 测试计划

- **P0（约 15 个）**：附件 JSON 迁移、重复启动与恢复；飞书单图/富文本三图结构化入库且正文保留回滚路径；Claude 冷启动三图在 `query()` 第一次 `next()` 同消息出现；active IPC 单图与多文件合并；5xx/账号轮换重试不丢附件；成功原生图片不暴露路径；旧纯文本不变；四种非原生模式路径降级；真飞书三图 E2E。
- **P1（约 15 个）**：JPEG/PNG/GIF/WebP 文件签名；缺失、伪图片、越界路径、symlink、目录、单图 5 MiB 边界、总量 20 MiB 边界、数量超限的逐图降级；损坏 attachments JSON；主进程重启恢复；debug/异常日志无 base64 且路径脱敏；两条消息各两图归属唯一。
- **P2（约 3 个）**：多消息多图稳定顺序、预算边界精确值、旧路径消息兼容。
- **纯函数测试**：附件 JSON 编解码、base64 大小估算、预算选择、标签排序、SDK content blocks 组装，全部零 mock，并做“恢复无条件路径输入/不附 image block/拆成多条 SDKUserMessage”反向变异验证。
- **I/O 测试**：SQLite 临时库、飞书下载 mock、GroupQueue IPC 临时目录和 runner 临时图片文件；只 mock 外部飞书 API，不 mock 被测业务函数。
