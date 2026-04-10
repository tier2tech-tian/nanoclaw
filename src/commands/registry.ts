import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import type { GroupQueue } from '../group-queue.js';
import { findChannel } from '../router.js';
import { logger } from '../logger.js';
import type { Command, CommandContext } from './types.js';

const commands: Command[] = [];

export function registerCommand(cmd: Command): void {
  if (commands.some((c) => c.name === cmd.name)) {
    throw new Error(`命令 "${cmd.name}" 已注册，禁止重复注册`);
  }
  commands.push(cmd);
}

export interface DispatchDeps {
  chatJid: string;
  msg: NewMessage;
  group: RegisteredGroup;
  channels: Channel[];
  sessions: Record<string, string>;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  deleteSession: (folder: string) => void;
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
}

/**
 * 匹配并执行命令。返回 true 表示已处理（调用方应 return），false 表示未匹配。
 */
export async function dispatch(
  trimmed: string,
  deps: DispatchDeps,
): Promise<boolean> {
  // '/ ' 开头不算命令
  if (trimmed.startsWith('/ ')) return false;

  // 精确匹配优先
  let matched = commands.find((c) => !c.hasArgs && trimmed === c.name);

  // 未命中则前缀匹配（hasArgs: true）
  if (!matched) {
    matched = commands.find(
      (c) =>
        c.hasArgs && (trimmed === c.name || trimmed.startsWith(c.name + ' ')),
    );
  }

  if (!matched) return false;

  // channel 空值守卫
  const channel = findChannel(deps.channels, deps.chatJid);
  if (!channel) {
    logger.warn(
      { chatJid: deps.chatJid, cmd: matched.name },
      '命令匹配但 channel 未找到',
    );
    return true; // 命令已匹配，不应穿透到"未知命令"
  }

  // 权限检查
  if (matched.requiresMain && !deps.group?.isMain) {
    await channel
      .sendMessage(deps.chatJid, '此命令仅限主群使用')
      .catch(() => {});
    return true;
  }

  // 提取 args
  const args = trimmed.slice(matched.name.length).trim();

  try {
    await matched.handler({
      chatJid: deps.chatJid,
      args,
      group: deps.group,
      channel,
      msg: deps.msg,
      sessions: deps.sessions,
      queue: deps.queue,
      registeredGroups: deps.registeredGroups,
      deleteSession: deps.deleteSession,
      setRegisteredGroup: deps.setRegisteredGroup,
    });
  } catch (err) {
    logger.error({ err, cmd: matched.name }, '命令执行失败');
    await channel
      .sendMessage(deps.chatJid, `命令执行失败: ${(err as Error).message}`)
      .catch(() => {});
  }
  return true;
}

/**
 * 生成 help 文本。
 * @param prefix 前缀，如 '❓ 未知命令 "/foo"，'
 */
export function getHelp(prefix?: string): string {
  const sorted = [...commands].sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999),
  );
  const lines = sorted.map((c) => {
    let line = `${c.name} — ${c.description}`;
    if (c.subcommands) {
      for (const sub of c.subcommands) {
        line += `\n  ${sub.usage} — ${sub.description}`;
      }
    }
    return line;
  });

  const header = prefix ? `${prefix}可用命令：\n` : '可用命令：\n';
  const suffix = `\n\n消息前缀修饰符：\n! — Sonnet 快速（无思考）\n!! — Sonnet 深度思考\n~ — 关闭思考（默认模型）\n+ — Opus 4.6 深度思考`;
  return header + lines.join('\n') + suffix;
}

export function getRegisteredCommands(): readonly Command[] {
  return commands;
}
