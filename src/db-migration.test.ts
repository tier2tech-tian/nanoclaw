import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('幂等迁移旧 messages 表并恢复附件读写', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE messages (
          id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT NOT NULL,
          is_from_me INTEGER DEFAULT 0,
          is_bot_message INTEGER DEFAULT 0,
          reply_to_message_id TEXT,
          reply_to_message_content TEXT,
          reply_to_sender_name TEXT,
          PRIMARY KEY (id, chat_jid)
        );
        INSERT INTO messages
          (id, chat_jid, sender, sender_name, content, timestamp)
        VALUES
          ('old', 'fs:legacy', 'u1', '旧用户', '旧消息', '2026-01-01T00:00:00.000Z');
      `);
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, storeMessage, getMessagesSince, _closeDatabase } =
        await import('./db.js');
      initDatabase();
      _closeDatabase();
      initDatabase();

      storeMessage({
        id: 'new',
        chat_jid: 'fs:legacy',
        sender: 'u1',
        sender_name: '旧用户',
        content: '新消息\n[图片: /group/new.jpg]',
        timestamp: '2026-01-02T00:00:00.000Z',
        attachments: [
          { type: 'image', path: '/group/new.jpg', source: 'feishu' },
        ],
      });

      const messages = getMessagesSince(
        'fs:legacy',
        '2025-01-01T00:00:00.000Z',
        'BOT',
      );
      expect(messages[0].attachments).toEqual([]);
      expect(messages[1].attachments).toEqual([
        { type: 'image', path: '/group/new.jpg', source: 'feishu' },
      ]);

      const verifyDb = new Database(dbPath, { readonly: true });
      const columns = verifyDb
        .prepare('PRAGMA table_info(messages)')
        .all() as Array<{
        name: string;
      }>;
      expect(
        columns.filter((column) => column.name === 'attachments_json'),
      ).toHaveLength(1);
      verifyDb.close();
      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
