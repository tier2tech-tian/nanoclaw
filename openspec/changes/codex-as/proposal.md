## Why

当前 Codex 接入按轮运行 codex exec，不能在执行中接收补充。用户需要新增独立 codex-as 模式试用运行中补充，保留原 codex 并沿用现有切换规则。

## What Changes

- /mode 新增 codex-as，继续保存群配置、终止旧进程及清除会话绑定。
- 新 runner 以 Codex app-server 标准输入输出通信，支持 turn/start 与 turn/steer，转换为现有进度和终态协议。
- 新模式复用 Codex 模型、权限、认证、技能、工具配置；不修改旧 codex exec 行为。
- 补充先落地认领，明确接受才完成；断线不盲目重投，保留不确定消息并告知用户。

## Capabilities

### New Capabilities
- `codex-as-mode`: 独立模式接入、运行中补充、消息结算、进度终态与兼容性。

### Modified Capabilities
无。

## Impact

NanoClaw 的模式声明和识别、群设置及帮助、agent-runner 路由和新增 App Server 适配器、相关测试。无数据库迁移，无 Nine/sandbox-api 改动，不自动启用任何群或重启共享服务。
