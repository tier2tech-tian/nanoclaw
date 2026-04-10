import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import type { GroupQueue } from '../group-queue.js';

export interface Command {
  name: string; // '/reset'
  description: string; // '杀进程，保留 session'
  hasArgs?: boolean; // true 时前缀匹配 '/account xxx'，false 时精确匹配
  requiresMain?: boolean; // 仅 main group 可用
  order?: number; // help 显示排序（默认注册顺序）
  subcommands?: { usage: string; description: string }[];
  handler: (ctx: CommandContext) => Promise<void>;
}

export interface CommandContext {
  chatJid: string;
  args: string; // 命令后的参数
  group: RegisteredGroup;
  channel: Channel;
  msg: NewMessage; // 原始消息
  // 可变状态
  sessions: Record<string, string>;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  // 辅助函数
  deleteSession: (folder: string) => void;
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
}
