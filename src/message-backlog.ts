/**
 * 待处理消息的取法。
 *
 * 一般群：只取最新 maxBatch 条（更早的当上下文噪声丢掉，防 trigger 群攒了几小时闲聊一次塞爆）。
 * 开了 foldBacklog 的会话（真人账号私聊/被 @ 的群，每条都是发给它的请求）：一条都不能丢，
 * 全部取出，超出 maxBatch 的较早消息合成一条放最前。agent 排队期间跨多轮攒下的也一并合并。
 */
import { getMessagesSince } from './db.js';
import type { NewMessage, RegisteredGroup } from './types.js';

/** 不设上限：取最新 N 条会把最早的排除在外、游标一推进就永久漏掉（SQLite LIMIT -1 = 全部）。
 *  量由真人账号 24 小时回看兜住 */
const NO_LIMIT = -1;

export function foldBacklog(
  msgs: NewMessage[],
  maxBatch: number,
): NewMessage[] {
  if (msgs.length <= maxBatch) return msgs;
  const cut = msgs.length - maxBatch + 1;
  const older = msgs.slice(0, cut);
  const last = older[older.length - 1];
  return [
    {
      ...last,
      content:
        `[补收：以下 ${older.length} 条是较早未处理的消息]\n` +
        older
          .map(
            (m) =>
              `${new Date(m.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} ${m.sender_name}：${m.content}`,
          )
          .join('\n'),
    },
    ...msgs.slice(cut),
  ];
}

export function getPendingMessages(
  chatJid: string,
  cursor: string,
  group: RegisteredGroup | undefined,
  botPrefix: string,
  maxBatch: number,
): NewMessage[] {
  if (!group?.containerConfig?.foldBacklog)
    return getMessagesSince(chatJid, cursor, botPrefix, maxBatch);
  return foldBacklog(
    getMessagesSince(chatJid, cursor, botPrefix, NO_LIMIT),
    maxBatch,
  );
}
