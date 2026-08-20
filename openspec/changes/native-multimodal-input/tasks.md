## 1. 消息合同与持久化

- [x] 1.1 先写失败测试，定义 `MessageAttachment`、附件 JSON 严格解析和旧消息空附件兼容
- [x] 1.2 实现 `messages.attachments_json` 幂等迁移、写入、读取与脱敏错误日志
- [x] 1.3 先写失败测试，覆盖飞书单图、富文本三图和合并转发的有序附件输出
- [x] 1.4 实现飞书结构化附件生成，正文继续保留旧版本可读路径，并脱敏现有图片下载日志

## 2. 主进程与 IPC 传输

- [x] 2.1 先写失败测试，覆盖冷启动 `ContainerInput` 和 active `GroupQueue.sendMessage` 的附件透传
- [x] 2.2 实现逐消息尾部标记精确剥离与重建、批次唯一标签、四种非 Claude runner 路径兼容和冷启动附件输入；测试重复路径、用户伪造标记及 XML 特殊字符路径
- [x] 2.3 实现 active IPC 单文件/多文件附件持久化、合并和稳定顺序，明确保持现有 at-most-once 语义
- [x] 2.4 覆盖瞬时 5xx 和账号轮换重试，保证附件参数贯穿全部 `runAgent` 递归路径

## 3. Claude SDK 原生图文

- [x] 3.1 先写失败测试，覆盖四种图片签名、realpath/symlink/普通文件边界、缺失/伪图/精确预算超限和成功图文 blocks
- [x] 3.2 实现 I/O 图片校验与纯预算/标签/blocks 组装分层，按 fd 大小预检并串行 base64 编码
- [x] 3.3 改造 `MessageStream`，让冷启动与 IPC follow-up 共用结构化 `SDKUserMessage` 构建器
- [x] 3.4 增加原生、降级、跳过数量结构化日志，并审计 debug input/飞书下载/异常日志，保证无 base64 且绝对路径脱敏

## 4. 验证与交付

- [x] 4.1 在 `query()` 边界捕获第一次 iterable 消息，并做反向变异证明恢复纯文本、删除 image block 或拆成多消息后测试会红
- [x] 4.2 运行定向测试、typecheck、build、lint 和全量测试并修复全部回归
- [x] 4.3 完成代码 review 与测试 review，处理所有阻塞和应修问题
- [x] 4.4 在真实飞书发送一条文字加三图，验证首轮 `native=3` 且图片理解正确；“无逐图 Read”只作观察证据
- [ ] 4.5 提交分层 commit、创建关联 Issue #5 的 PR，等待大杰确认后再合并
