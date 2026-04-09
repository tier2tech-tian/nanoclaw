# Tasks: `/usage` 指令

---

## Phase 1: 数据层

### T1: `oauth_credentials` 表 + CRUD

文件：`src/db.ts`

- 在 `createSchema()` 新增 `oauth_credentials` 表（见 design D1）
- 新增函数：
  - `getOAuthCredential(secretName: string): OAuthCredential | null`
  - `upsertOAuthCredential(secretName, { accessToken, refreshToken, expiresAt }): void`
  - `getAllOAuthCredentials(): OAuthCredential[]`
  - `updateCachedUsage(secretName, usage: string | null, error?: string): void`
- 类型定义放 `src/types.ts`
- 验收：`npx tsc --noEmit` 通过

---

## Phase 2: Usage API 核心

### T2: `src/usage-api.ts` — 新建文件

从 oh-my-claudecode `src/hud/usage-api.ts` 精简移植，**只保留**：
- `refreshAccessToken(refreshToken: string)` — POST `platform.claude.com/v1/oauth/token`
- `fetchUsage(accessToken: string)` — GET `api.anthropic.com/api/oauth/usage`
- `parseUsageResponse(response)` — 解析 five_hour / seven_day / sonnet / opus
- `getUsageForSecret(secretName: string)` — 完整流程（读 DB → 检查缓存 → 刷新 token → 查 API → 写回）
- `getUsageAll()` — Promise.all 并行查所有

**不移植的**：z.ai 支持、Keychain 读写、文件锁、custom provider

常量：
- `CACHE_TTL_MS = 30_000`
- `API_TIMEOUT_MS = 10_000`
- `OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'`
- `TOKEN_REFRESH_HOSTNAME = 'platform.claude.com'`
- `USAGE_API_HOSTNAME = 'api.anthropic.com'`

验收：类型完整，`npx tsc --noEmit` 通过

---

## Phase 3: 指令处理

### T3: `/usage` 和 `/usage all` 指令

文件：`src/index.ts`

在 `/account` 指令处理附近新增 `/usage` 分支：
- 解析 arg：无参 → 查当前，`all` → 查全部
- 确定当前 secret name：`getCurrentSecretName(agentId)` 通过 `onecli agents secrets --id` 查
- 调 `getUsageForSecret()` 或 `getUsageAll()`
- 格式化输出（见 design D3 格式）

格式化函数（放 `src/usage-api.ts` 或单独 `src/usage-format.ts`）：
- `formatUsage(result: UsageResult): string` — 单账号
- `formatUsageAll(results: UsageResult[], currentSecretName: string): string` — 所有账号

进度条渲染：
```
████░░░░░░ 45%  → 10 格，每格 10%
```

错误状态显示：
- `no_credentials` → `⚠️ 未绑定 OAuth 凭证`
- `auth` → `⚠️ 凭证已失效，请重新绑定`
- `network` → `⚠️ API 查询失败`

验收：飞书群发 `/usage` 能看到输出（先用 mock 数据）

### T4: `/usage bind <secretName> <refreshToken>` 子命令

文件：`src/index.ts`

- 解析 secretName + refreshToken
- 立即用 refreshToken 调 `refreshAccessToken()` 验证
  - 成功 → `upsertOAuthCredential()` 写入 DB → 回复「✅ 已绑定 anthropic-tian」
  - 失败 → 回复「❌ refreshToken 无效，请重新获取」
- 提示大杰撤回包含 token 的消息
- 验证 secretName 必须是 `onecli secrets list` 中存在的

验收：`/usage bind anthropic-tian xxxx` 后 DB 有记录，`/usage` 能查到余量

---

## Phase 4: 验证 & 提交

### T5: 编译 + 格式化

- `npx tsc --noEmit` 通过
- `npx prettier --write src/usage-api.ts src/db.ts src/index.ts`
- 手动验证：
  - oauth_credentials 表 schema 正确
  - refreshAccessToken HTTPS 调用参数完整
  - fetchUsage header 包含 `anthropic-beta: oauth-2025-04-20`
  - 缓存 TTL 30 秒生效
  - `/usage bind` 的 token 验证流程完整
  - 错误处理覆盖所有分支（无凭证/过期/网络/429）

### T6: 提交

- `git commit -m "feat: /usage 指令 — 查询 Claude 账号配额用量"`
- 包含文件：`src/usage-api.ts`（新增）、`src/db.ts`（改）、`src/index.ts`（改）、`src/types.ts`（改）
