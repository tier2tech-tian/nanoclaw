/**
 * 回填聊天索引 — 从 JSONL session 文件 + messages 表导入历史数据
 *
 * 用法:
 *   npx tsx scripts/backfill-chat-index.ts [--group <folder>] [--dry-run]
 *
 * 数据源优先级:
 *   1. JSONL session 文件（完整对话，含 bot 回复）
 *   2. messages 表（补充 JSONL 未覆盖的消息对）
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ASSISTANT_NAME, DATA_DIR } from '../src/config.js';
import { initDatabase, getDb } from '../src/db.js';
import { logger } from '../src/logger.js';
import {
  ChatIndex,
  chunkConversation,
  cleanContent,
} from '../src/chat-index.js';

// 初始化主 db 单例
initDatabase();

// --- CLI 参数 ---
const cliArgs = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx >= 0 ? cliArgs[idx + 1] : undefined;
}
const dryRun = cliArgs.includes('--dry-run');
const groupFilter = getArg('group');

const db = getDb();

interface GroupRow {
  jid: string;
  folder: string;
}

// --- JSONL 解析 ---

interface JsonlLine {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

/** 从 assistant content 中提取纯文本 */
function extractText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

/** 解析 JSONL 文件，提取 user+assistant 对话对 */
async function parseJsonlSession(
  filepath: string,
): Promise<Array<{ userText: string; botText: string; timestamp: string }>> {
  const pairs: Array<{
    userText: string;
    botText: string;
    timestamp: string;
  }> = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filepath),
    crlfDelay: Infinity,
  });

  let lastUserText = '';
  // 用文件修改时间作为粗略时间戳
  const stat = fs.statSync(filepath);
  const fileTime = stat.mtime.toISOString();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'user' && parsed.message?.role === 'user') {
      // 从 user message 中提取文本（去掉 XML context wrapper）
      let text = extractText(parsed.message.content);
      // 提取 <messages> 中的实际用户消息
      const msgMatch = text.match(
        /<message[^>]*>([\s\S]*?)<\/message>/g,
      );
      if (msgMatch) {
        text = msgMatch
          .map((m) => m.replace(/<\/?message[^>]*>/g, '').trim())
          .join('\n');
      }
      if (text.trim()) {
        lastUserText = text.trim();
      }
    } else if (
      parsed.message?.role === 'assistant' &&
      lastUserText
    ) {
      const botText = cleanContent(extractText(parsed.message.content));
      if (botText.trim()) {
        pairs.push({
          userText: lastUserText,
          botText: botText.trim(),
          timestamp: fileTime,
        });
        lastUserText = '';
      }
    }
  }

  return pairs;
}

async function main(): Promise<void> {
  console.log(`\n=== 聊天索引回填（JSONL + DB） ===`);
  if (dryRun) console.log('  [DRY RUN] 仅统计，不写入');
  if (groupFilter) console.log(`  群组过滤: ${groupFilter}`);

  // 获取群组映射
  const groups = db
    .prepare('SELECT jid, folder FROM registered_groups')
    .all() as GroupRow[];

  const folderToJid = new Map<string, string>();
  for (const g of groups) {
    folderToJid.set(g.folder, g.jid);
  }

  if (groupFilter && !folderToJid.has(groupFilter)) {
    console.error(`群组 "${groupFilter}" 不存在`);
    process.exit(1);
  }

  // 初始化 ChatIndex
  let chatIndex: ChatIndex | null = null;
  if (!dryRun) {
    chatIndex = new ChatIndex();
    await chatIndex.init();
  }

  // 已存在的 chunk IDs
  const existingIds = new Set<string>();
  const existing = db
    .prepare('SELECT id FROM chat_chunks')
    .all() as Array<{ id: string }>;
  for (const row of existing) {
    existingIds.add(row.id);
  }
  console.log(`  已有 chunk 数: ${existingIds.size}`);

  let totalChunks = 0;
  let totalPairs = 0;
  let skippedExisting = 0;
  let sessionCount = 0;

  // ========== Phase 1: JSONL session 文件 ==========
  console.log(`\n--- Phase 1: JSONL session 文件 ---`);

  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const groupDirs = fs.readdirSync(sessionsDir);

    for (const groupFolder of groupDirs) {
      if (groupFilter && groupFolder !== groupFilter) continue;

      const chatJid = folderToJid.get(groupFolder);
      if (!chatJid) continue; // 未注册的群跳过

      // 递归找 JSONL 文件（排除 subagents）
      const groupSessionDir = path.join(sessionsDir, groupFolder);
      const jsonlFiles: string[] = [];

      function findJsonl(dir: string): void {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'subagents') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findJsonl(fullPath);
          } else if (entry.name.endsWith('.jsonl')) {
            jsonlFiles.push(fullPath);
          }
        }
      }

      findJsonl(groupSessionDir);
      console.log(`  [${groupFolder}] ${jsonlFiles.length} 个 session 文件`);

      for (const jsonlPath of jsonlFiles) {
        sessionCount++;
        const pairs = await parseJsonlSession(jsonlPath);

        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          totalPairs++;

          const sessionId = path.basename(jsonlPath, '.jsonl');
          const msgIdPrefix = `jsonl_${sessionId}_${i}`;

          const chunks = chunkConversation(pair.userText, pair.botText, {
            chat_jid: chatJid,
            group_folder: groupFolder,
            userMsgId: `${msgIdPrefix}_u`,
            botMsgId: `${msgIdPrefix}_b`,
            sender_name: '用户',
            timestamp: pair.timestamp,
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
    }
  }

  console.log(`  session 文件: ${sessionCount}`);
  console.log(`  对话对: ${totalPairs}`);
  console.log(`  新 chunk: ${totalChunks}`);

  // ========== Phase 2: messages 表补充 ==========
  console.log(`\n--- Phase 2: messages 表补充 ---`);
  let dbPairs = 0;
  let dbChunks = 0;

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
  sql += ' ORDER BY m.chat_jid, m.timestamp ASC';

  const allMessages = db.prepare(sql).all(...params) as MessageRow[];
  const groupMap = new Map<string, string>();
  for (const g of groups) {
    groupMap.set(g.jid, g.folder);
  }

  // 按 chat_jid 分组
  const byChatJid = new Map<string, MessageRow[]>();
  for (const msg of allMessages) {
    const arr = byChatJid.get(msg.chat_jid) || [];
    arr.push(msg);
    byChatJid.set(msg.chat_jid, arr);
  }

  for (const [chatJid, messages] of byChatJid) {
    const folder = groupMap.get(chatJid);
    if (!folder) continue;

    for (let i = 0; i < messages.length; i++) {
      const userMsg = messages[i];
      if (userMsg.is_bot_message || userMsg.is_from_me) continue;
      if (!userMsg.content?.trim()) continue;

      let botMsg: MessageRow | null = null;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].is_bot_message || messages[j].is_from_me) {
          botMsg = messages[j];
          break;
        }
        break;
      }

      if (!botMsg || !botMsg.content?.trim()) continue;
      dbPairs++;

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

        dbChunks++;
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

  console.log(`  DB 消息对: ${dbPairs}`);
  console.log(`  DB 新 chunk: ${dbChunks}`);

  // ========== 汇总 ==========
  console.log(`\n--- 汇总 ---`);
  console.log(`  总对话对: ${totalPairs + dbPairs}`);
  console.log(`  总新 chunk: ${totalChunks}`);
  console.log(`  跳过已存在: ${skippedExisting}`);

  // Qdrant 向量索引
  if (!dryRun && chatIndex && totalChunks > 0) {
    console.log(`\n刷写 WAL checkpoint...`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('开始 Qdrant 向量索引...');
    await chatIndex.retryUnindexed();
    await chatIndex.dispose();
    console.log('完成');
  } else if (!dryRun && chatIndex) {
    await chatIndex.dispose();
  }

  console.log(`\n=== 回填完成 ===\n`);
}

main().catch((err) => {
  console.error('回填失败:', err);
  process.exit(1);
});
