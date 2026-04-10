import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

// /clear — 清除 session，开始新对话（对齐 Claude Code /clear）
registerCommand({
  name: '/clear',
  description: '清除 session，开始新对话（记忆保留）',
  order: 10,
  handler: async (ctx) => {
    delete ctx.sessions[ctx.group.folder];
    ctx.deleteSession(ctx.group.folder);
    logger.info({ group: ctx.group.folder }, '/clear: session 已清除');
    await ctx.channel.sendMessage(
      ctx.chatJid,
      '对话已清除，下次消息将开始新 session。记忆保留。',
    );
  },
});

// /reset — 杀进程但保留 session，下次启动恢复上下文
registerCommand({
  name: '/reset',
  description: '杀进程，保留 session（用于加载新代码）',
  order: 11,
  handler: async (ctx) => {
    const killed = ctx.queue.killGroup(ctx.chatJid);
    logger.info(
      { group: ctx.group.folder, killed },
      '/reset: 进程已终止，session 保留',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      killed
        ? '进程已终止，session 保留。下次消息将恢复上下文。'
        : '无活跃进程。下次消息将恢复上下文。',
    );
  },
});

// /new — 杀进程 + 删 session，开启全新会话
registerCommand({
  name: '/new',
  description: '杀进程 + 清 session，开启全新会话',
  order: 12,
  handler: async (ctx) => {
    const killed = ctx.queue.killGroup(ctx.chatJid);
    delete ctx.sessions[ctx.group.folder];
    ctx.deleteSession(ctx.group.folder);
    logger.info(
      { group: ctx.group.folder, killed },
      '/new: 进程已终止，session 已清除',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      killed
        ? '进程已终止，session 已清除。下次消息将开启全新会话。'
        : 'session 已清除。下次消息将开启全新会话。',
    );
  },
});
