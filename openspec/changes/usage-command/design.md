# Design: `/usage` 指令

## D1: 数据模型 — `oauth_credentials` 表

存在 `store/messages.db`（现有 SQLite）：

```sql
CREATE TABLE IF NOT EXISTS oauth_credentials (
  secret_name TEXT PRIMARY KEY,        -- OneCLI secret name, e.g. 'anthropic-tian'
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,         -- Unix timestamp ms
  last_usage_check INTEGER,            -- 上次查询 usage 的 Unix timestamp ms
  cached_usage TEXT,                    -- JSON string: { fiveHourPercent, weeklyPercent, ... }
  error_state TEXT,                     -- null | 'auth' | 'network'
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**CRUD 函数**（在 `src/db.ts` 新增）：
- `getOAuthCredential(secretName: string): OAuthCredential | null`
- `upsertOAuthCredential(secretName: string, cred: OAuthCredentialInput): void`
- `getAllOAuthCredentials(): OAuthCredential[]`
- `updateCachedUsage(secretName: string, usage: string | null, error?: string): void`

---

## D2: 核心模块 — `src/usage-api.ts` (~200 行)

从 oh-my-claudecode `src/hud/usage-api.ts` 精简移植，只保留核心函数：

### 接口

```typescript
interface RateLimits {
  fiveHourPercent: number;
  weeklyPercent?: number;
  fiveHourResetsAt?: Date;
  weeklyResetsAt?: Date;
  sonnetWeeklyPercent?: number;
  opusWeeklyPercent?: number;
}

interface UsageResult {
  secretName: string;
  rateLimits: RateLimits | null;
  error?: 'auth' | 'network' | 'no_credentials';
  stale?: boolean;  // 缓存数据
}
```

### 核心函数

```typescript
// 查单个账号
export async function getUsageForSecret(secretName: string): Promise<UsageResult>

// 查所有账号（并行）
export async function getUsageAll(): Promise<UsageResult[]>
```

### 流程

```
getUsageForSecret(secretName)
  ├── 读 DB: getOAuthCredential(secretName)
  │   └── 没有凭证 → return { error: 'no_credentials' }
  │
  ├── 检查缓存: last_usage_check + 30s > now?
  │   └── 未过期 → 返回 cached_usage
  │
  ├── 检查 accessToken 过期: expires_at < now?
  │   └── 过期 → refreshAccessToken(refreshToken)
  │       ├── 成功 → 更新 DB（新 accessToken + expiresAt）
  │       └── 失败 → return { error: 'auth' }
  │
  ├── fetchUsage(accessToken)
  │   ├── HTTP GET api.anthropic.com/api/oauth/usage
  │   │   Header: Authorization: Bearer {accessToken}
  │   │           anthropic-beta: oauth-2025-04-20
  │   ├── 200 → parseUsageResponse() → 更新缓存 → return { rateLimits }
  │   ├── 429 → return { error: 'rate_limited', rateLimits: cached }
  │   └── 其他 → return { error: 'network' }
  │
  └── updateCachedUsage() 写回 DB
```

### Token 刷新

```typescript
async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null>
```

POST `https://platform.claude.com/v1/oauth/token`:
```
grant_type=refresh_token
refresh_token={refreshToken}
client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e  // Claude Code 公开 OAuth client_id
```

---

## D3: `/usage` 指令处理 — `src/index.ts`

在现有指令处理逻辑（`/account` 附近）新增：

```typescript
if (command === '/usage') {
  const arg = text.slice('/usage'.length).trim();
  
  if (arg === 'all') {
    // 查所有账号
    const results = await getUsageAll();
    const reply = formatUsageAll(results, currentSecretName);
    ch.sendMessage(chatJid, reply);
  } else {
    // 查当前账号
    const result = await getUsageForSecret(currentSecretName);
    const reply = formatUsage(result);
    ch.sendMessage(chatJid, reply);
  }
}
```

### 输出格式

**`/usage`（单个账号）：**
```
📊 anthropic-tian 用量
5h:  ████░░░░░░ 45% (3h42m 重置)
7d:  █░░░░░░░░░ 12% (2d5h 重置)
```

**`/usage all`（所有账号）：**
```
📊 账号用量
anthropic-tian:       5h: 45% | 7d: 12%  ← 当前
anthropic-Elizabeth:   5h: 22% | 7d: 8%
anthropic-Blanch:     5h: 67% | 7d: 31%
```

当前群使用的 secret 加 `← 当前` 标记。

### 确定"当前 secret"

从 OneCLI 查：
```typescript
function getCurrentSecretName(agentId: string): string | null {
  const agents = JSON.parse(execSync('onecli agents list', ...));
  const agent = agents.find(a => a.identifier === agentId);
  const agentSecrets = JSON.parse(execSync(`onecli agents secrets --id ${agent.id}`, ...));
  // 拿到当前绑定的 secret id → 再从 secrets list 找 name
}
```

---

## D4: 凭证初始化 — `/usage setup` 子命令

首次使用时需要一次性导入 OAuth 凭证。

### 交互流程

用户在群里发 `/usage setup <secretName>`：

1. NanoClaw 提示：「请登录账号 <secretName> 后运行脚本导入凭证」
2. 大杰执行：
   ```bash
   # 登录对应账号
   CLAUDE_CONFIG_DIR=/tmp/claude-setup claude login
   # 登录完成后导入到 NanoClaw
   nanoclaw usage-import --secret anthropic-tian --from /tmp/claude-setup
   ```
3. 或者用 Keychain 直接导入（如果刚用 `claude login` 登录过）：
   ```bash
   nanoclaw usage-import --secret anthropic-tian --from-keychain
   ```

### 简化方案：直接在群里粘贴 refreshToken

考虑到大杰是管理员，更快的方式：

```
/usage bind anthropic-tian <refreshToken>
```

NanoClaw 收到后立即用 refreshToken 换 accessToken 验证，成功则写入 DB。refreshToken 从 Keychain 或 `.credentials.json` 手动复制。

---

## D5: 安全

- **refreshToken 存 DB**：`store/messages.db` 是本地文件，仅 NanoClaw 进程可读
- **不向容器暴露**：OAuth 凭证不注入到 Docker 容器环境变量
- **不 log token**：日志里只记录 secretName、状态，不记录 token 内容
- **群消息中的 token**：`/usage bind` 指令成功后立即提示大杰删除消息（飞书可撤回）
- **HTTPS only**：API 调用全部走 HTTPS

---

## D6: 缓存策略

- **缓存 TTL**：30 秒（同一账号 30 秒内不重复查）
- **缓存存储**：DB `cached_usage` 字段（JSON string）
- **stale 标记**：缓存返回时标记 `stale: true`
- **429 退避**：指数退避，最大 5 分钟（同 OMC）
- **缓存失效**：`/account` 切换时不主动清缓存（各账号独立缓存）
