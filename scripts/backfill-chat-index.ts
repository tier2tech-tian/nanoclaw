/**
 * 回填聊天索引 — 将历史消息分块写入 chat_chunks + Qdrant
 *
 * 用法:
 *   npx tsx scripts/backfill-chat-index.ts [--group <folder>] [--days <N>] [--dry-run]
 *
 * 参数:
 *   --group  只回填指定群组（folder 名），不传则回填所有
 *   --days   只回填最近 N 天，默认全部
 *   --dry-run 不写入，仅统计
 */
import { ASSISTANT_NAME } from '../src/config.js';
import { initDatabase, getDb } from '../src/db.js';
import { logger } from '../src/logger.js';
import {
  ChatIndex,
  chunkConversation,
  ChatChunk,
} from '../src/chat-index.js';

// 初始化主 db 单例（ChatIndex.retryUnindexed 和本脚本都用 getDb()）
initDatabase();

// --- CLI 参数 ---
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const dryRun = args.includes('--dry-run');
const groupFilter = getArg('group');
const daysFilter = getArg('days') ? parseInt(getArg('days')!, 10) : undefined;

// --- 数据库连接（复用主 db 单例）---
const db = getDb();

interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

interface GroupRow {
  jid: string;
  folder: string;
}

async function main(): Promise<void> {
  console.log(`\n=== 聊天索引回填 ===`);
  if (dryRun) console.log('  [DRY RUN] 仅统计，不写入');
  if (groupFilter) console.log(`  群组过滤: ${groupFilter}`);
  if (daysFilter) console.log(`  天数过滤: 最近 ${daysFilter} 天`);

  // 获取群组 → folder 映射
  const groups = db
    .prepare('SELECT jid, folder FROM registered_groups')
    .all() as GroupRow[];

  const groupMap = new Map<string, string>();
  for (const g of groups) {
    groupMap.set(g.jid, g.folder);
  }

  if (groupFilter) {
    // 检查群组是否存在
    const found = groups.find((g) => g.folder === groupFilter);
    if (!found) {
      console.error(`群组 "${groupFilter}" 不存在`);
      process.exit(1);
    }
  }

  // 初始化 ChatIndex（连接 Qdrant 等）
  let chatIndex: ChatIndex | null = null;
  if (!dryRun) {
    chatIndex = new ChatIndex();
    await chatIndex.init();
  }

  // 查询消息对（用户消息 + 紧随的 bot 回复）
  let sql = `
    SELECT m.*
    FROM messages m
    JOIN registered_groups rg ON rg.jid = m.chat_jid
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (groupFilter) {
    sql += ' AND rg.folder = ?';
    params.push(groupFilter);
  }
  if (daysFilter) {
    const since = new Date(Date.now() - daysFilter * 86400000).toISOString();
    sql += ' AND m.timestamp >= ?';
    params.push(since);
  }

  sql += ' ORDER BY m.chat_jid, m.timestamp ASC';

  const allMessages = db.prepare(sql).all(...params) as MessageRow[];
  console.log(`  总消息数: ${allMessages.length}`);

  // 按 chat_jid 分组
  const byChatJid = new Map<string, MessageRow[]>();
  for (const msg of allMessages) {
    const arr = byChatJid.get(msg.chat_jid) || [];
    arr.push(msg);
    byChatJid.set(msg.chat_jid, arr);
  }

  let totalChunks = 0;
  let totalPairs = 0;
  let skippedExisting = 0;

  // 已存在的 chunk IDs（避免重复插入）
  const existingIds = new Set<string>();
  const existing = db
    .prepare('SELECT id FROM chat_chunks')
    .all() as Array<{ id: string }>;
  for (const row of existing) {
    existingIds.add(row.id);
  }
  console.log(`  已有 chunk 数: ${existingIds.size}`);

  // 逐群组处理
  for (const [chatJid, messages] of byChatJid) {
    const folder = groupMap.get(chatJid);
    if (!folder) continue;
    if (groupFilter && folder !== groupFilter) continue;

    // 配对：用户消息 + 下一条 bot 回复
    for (let i = 0; i < messages.length; i++) {
      const userMsg = messages[i];
      if (userMsg.is_bot_message || userMsg.is_from_me) continue;
      if (!userMsg.content?.trim()) continue;

      // 找紧随的 bot 回复
      let botMsg: MessageRow | null = null;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].is_bot_message || messages[j].is_from_me) {
          botMsg = messages[j];
          break;
        }
        // 遇到下一条用户消息就停
        break;
      }

      if (!botMsg || !botMsg.content?.trim()) continue;

      totalPairs++;

      const chunks = chunkConversation(userMsg.content, botMsg.content, {
        chat_jid: chatJid,
        group_folder: folder,
        userMsgId: userMsg.id,
        botMsgId: botMsg.id,
        sender_name: userMsg.sender_name || '用户',
        timestamp: userMsg.timestamp,
      });

      for (const chunk of chunks) {
        if (existingIds.has(chunk.id)) {
          skippedExisting++;
          continue;
        }

        totalChunks++;

        if (!dryRun) {
          db.prepare(
            `INSERT OR IGNORE INTO chat_chunks
             (id, chat_jid, group_folder, message_ids, chunk_text, sender_names, start_time, end_time, qdrant_indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            chunk.id,
            chunk.chat_jid,
            chunk.group_folder,
            chunk.message_ids,
            chunk.chunk_text,
            chunk.sender_names,
            chunk.start_time,
            chunk.end_time,
            0,
          );
          existingIds.add(chunk.id);
        }
      }
    }
  }

  console.log(`\n--- 结果 ---`);
  console.log(`  消息对: ${totalPairs}`);
  console.log(`  新 chunk: ${totalChunks}`);
  console.log(`  跳过已存在: ${skippedExisting}`);

  // Qdrant 索引由 retryUnindexed 自动处理
  // 注意：先 checkpoint WAL，确保 retryUnindexed 用 getDb() 能读到刚写入的 chunk
  if (!dryRun && chatIndex) {
    console.log(`\n刷写 WAL checkpoint...`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('开始 Qdrant 向量索引...');
    await chatIndex.retryUnindexed();
    await chatIndex.dispose();
    console.log('完成');
  }

  console.log(`\n=== 回填完成 ===\n`);
}

main().catch((err) => {
  console.error('回填失败:', err);
  process.exit(1);
});
