# Proposal: `/usage` 指令 — 查询 Claude 账号配额用量

## 问题

大杰在 NanoClaw 里通过 OneCLI 管理多个 Anthropic 订阅账号（tian / Elizabeth / Blanch），并用 `/account` 指令切换。但现在无法在飞书群里查看某个账号的**真实配额使用率**（5h / 7d / sonnet / opus 窗口），只能靠 `rotateAccount` 基于本地 token 估算，不准。

oh-my-claudecode 项目已证明：通过 OAuth accessToken 调用 `api.anthropic.com/api/oauth/usage` 能拿到官方真实用量。但这套机制要求**每个账号都要有 OAuth 凭证**（refreshToken + accessToken + expiresAt），而目前 Mac 的 Keychain 里只有一份（最后一次 `claude login` 那个）。

## 方案

NanoClaw 自己管理 OAuth 凭证，**完全独立于 OneCLI 和 Claude Code CLI**：

1. **新增 SQLite 表 `oauth_credentials`** 存每个 OneCLI secret 对应的 OAuth 凭证
2. **新增 `/usage` 指令**：
   - `/usage` → 查当前群绑定的那个 secret 的余量
   - `/usage all` → 并行查所有配置了 OAuth 凭证的账号
3. **移植 oh-my-claudecode 的 usage-api 核心逻辑**（精简版 ~200 行）
4. **一次性引导注入**：首次使用时提示大杰用 `claude login` 给每个账号登录，然后运行辅助脚本把 Keychain 里的凭证导入到 NanoClaw DB

## 不改的部分

- **OneCLI** — 完全不动，它继续管 API Key，NanoClaw 自己加一层 OAuth 存储
- **现有 `/account` 指令** — 不变，还是管 OneCLI secret 切换
- **rotateAccount 机制** — 不变，只是以后可以基于真实 usage 判断是否需要轮换（可选优化，不在本次 change 范围内）
- **Claude Code CLI 的 Keychain** — 只读，不写

## 约束

- 凭证存 `store/messages.db` 新表（跟现有 NanoClaw 数据一起）
- accessToken 过期自动用 refreshToken 刷新，刷新失败记录错误状态
- API 调用走 HTTPS，必须带 `anthropic-beta: oauth-2025-04-20` header
- 缓存：同一账号 30 秒内不重复查
- 不向第三方泄露任何 token
