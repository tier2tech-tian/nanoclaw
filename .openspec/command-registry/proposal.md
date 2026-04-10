# 命令系统重构：Command Registry 模式

## 背景

`src/index.ts` 约 1600 行，其中命令处理（`/help`, `/clear`, `/reset`, `/new`, `/account`, `/usage`, `/trigger`, `/notrigger`, `/cwd`, `/remote-control` 等 15+ 个命令）全部用 `if (trimmed === '/xxx')` 平铺在 `onMessage` 回调里，约 385 行。

**问题：**
1. 巨型函数，命令逻辑和消息路由耦合
2. 每个命令重复 `findChannel → sendMessage → .catch(logger.error)` 样板
3. help 列表在两处手动维护（主 help + 未知命令 fallback），容易不同步
4. 加新命令要改三处：处理逻辑 + 两处 help

## 方案

采用函数式 Command Registry 模式（与现有 `channels/registry.ts` 风格一致）。

### 核心接口

```typescript
// src/commands/types.ts
interface Command {
  name: string;              // '/reset'
  description: string;       // '杀进程，保留 session'
  hasArgs?: boolean;         // true 时前缀匹配 '/account xxx'，false 时精确匹配
  requiresMain?: boolean;    // 仅 main group 可用
  order?: number;            // help 显示排序（默认注册顺序）
  subcommands?: { usage: string; description: string }[];  // 仅用于 help 生成
  handler: (ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
  chatJid: string;
  args: string;              // 命令后的参数
  group: RegisteredGroup;
  channel: Channel;          // dispatch 层保证非 null（空值守卫）
  msg: NewMessage;           // 原始消息（/remote-control 需要）
  // 可变状态（JS 引用语义，handler 可直接 delete/修改）
  sessions: Record<string, string>;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  // 辅助函数（持久化层操作）
  deleteSession: (folder: string) => void;
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
}
```

### Registry（函数式，非 class）

```typescript
// src/commands/registry.ts
const commands: Command[] = [];

export function registerCommand(cmd: Command): void;

// 匹配优先级：精确匹配 > 前缀匹配（hasArgs: true 要求 name + ' '）
// 统一 try/catch + 权限检查（requiresMain）
// channel 空值守卫：findChannel 返回 undefined 时直接 bail out
export function dispatch(trimmed: string, ctx: Partial<CommandContext>): Promise<boolean>;

// prefix: 用于未知命令提示，如 '❓ 未知命令 "/foo"，'
// suffix: 追加前缀修饰符说明（!、!!、~、+）
export function getHelp(prefix?: string): string;
```

### 文件组织（按逻辑分组）

```
src/commands/
├── types.ts            — Command, CommandContext 接口
├── registry.ts         — registerCommand, dispatch, getHelp
├── session.ts          — /clear, /reset, /new
├── account.ts          — /account, /usage
├── remote-control.ts   — /remote-control, /remote-control-end（依赖较重，独立文件）
└── misc.ts             — /help, /trigger, /notrigger, /cwd
```

### dispatch 统一处理

```typescript
export async function dispatch(trimmed: string, ctx: ...): Promise<boolean> {
  // 1. 排除 '/ ' 开头（空格后跟内容不是命令）
  if (trimmed.startsWith('/ ')) return false;

  // 2. 精确匹配优先
  let matched = commands.find(c => !c.hasArgs && trimmed === c.name);

  // 3. 未命中则前缀匹配（要求 name + ' '）
  if (!matched) {
    matched = commands.find(c =>
      c.hasArgs && (trimmed === c.name || trimmed.startsWith(c.name + ' ')));
  }

  if (!matched) return false;

  // 4. channel 空值守卫
  const channel = findChannel(channels, ctx.chatJid);
  if (!channel) return false;

  // 5. 权限检查
  if (matched.requiresMain && !ctx.group?.isMain) {
    await channel.sendMessage(ctx.chatJid, '此命令仅限主群使用');
    return true;
  }

  // 6. 提取 args
  const args = trimmed.slice(matched.name.length).trim();

  // 7. 统一 try/catch
  try {
    await matched.handler({ ...ctx, channel, args } as CommandContext);
  } catch (err) {
    logger.error({ err, cmd: matched.name }, '命令执行失败');
    await channel.sendMessage(ctx.chatJid,
      `命令执行失败: ${(err as Error).message}`).catch(() => {});
  }
  return true;
}
```

### 特殊项

- `!`/`!!`/`~`/`+` 前缀修饰符不是命令（不 return，继续走 LLM），不注册到 registry
- `getHelp()` 自动生成命令列表，末尾追加修饰符说明作为固定 suffix
- `/help` 自动从 registry 生成，单一信息源
- 子命令（`/account auto on|off`）在 handler 内部 if-else 分发，不引入子 registry

### follow-up

- `/account` 内 6 处 `execSync` 改为 `execFile` + `promisify`（不在本次重构范围）

## 迁移策略

**两步渐进迁移：**

1. **PR-1：骨架 + session 命令**
   - 创建 `commands/types.ts`、`registry.ts`、`session.ts`
   - 迁移 `/clear`、`/reset`、`/new`
   - `index.ts` 加入 `dispatch()` 调用，保留未迁移命令的原始 if-else
   - **不改 /help**，保持旧 help 不变，避免中间态不一致

2. **PR-2：剩余命令**
   - 迁移 `/account`、`/usage` → `account.ts`
   - 迁移 `/remote-control`、`/remote-control-end` → `remote-control.ts`
   - 迁移 `/help`、`/trigger`、`/notrigger`、`/cwd` → `misc.ts`
   - 删除 index.ts 所有旧 if-else + 两处手写 help
   - 用 `getHelp()` 替换

## 主函数改造后

```typescript
// index.ts onMessage 里：
const handled = await dispatch(trimmed, {
  chatJid, group, msg, sessions, queue, registeredGroups,
  deleteSession, setRegisteredGroup,
});
if (!handled && trimmed.startsWith('/') && !trimmed.startsWith('/ ')) {
  const unknownCmd = trimmed.split(/\s/)[0];
  const ch = findChannel(channels, chatJid);
  ch?.sendMessage(chatJid, getHelp(`❓ 未知命令 "${unknownCmd}"，`));
  return;
}
// 继续走 LLM 路由...
```

## 验收标准

- [ ] 所有现有命令功能不变
- [ ] help 输出与当前一致（单一信息源自动生成）
- [ ] 未知命令提示包含具体命令名
- [ ] `/remote-control` 权限检查正常（仅 main group）
- [ ] 新增命令只需一个文件 + `registerCommand()` 调用
- [ ] index.ts 减少 300+ 行
- [ ] `/ ` 开头的消息不被当作未知命令
