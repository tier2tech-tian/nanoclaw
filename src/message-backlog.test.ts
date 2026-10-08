import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { getPendingMessages } from './message-backlog.js';
import type { RegisteredGroup } from './types.js';

const JID = 'nine:oc_p2p';
const group = (foldBacklog: boolean) =>
  ({
    name: 'nine · 张三',
    folder: 'nine-oc_p2p',
    trigger: '@nine',
    added_at: '2026-10-08T00:00:00.000Z',
    containerConfig: { foldBacklog },
  }) as RegisteredGroup;

function store(i: number) {
  storeMessage({
    id: `om_${i}`,
    chat_jid: JID,
    sender: 'ou_zhang',
    sender_name: '张三',
    content: `第${i}条`,
    timestamp: new Date(Date.UTC(2026, 9, 8, 12, 0, i)).toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });
}

describe('getPendingMessages', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(
      JID,
      '2026-10-08T12:00:00.000Z',
      '张三',
      'feishu-user',
      false,
    );
  });

  it('agent 排队期间两轮各收 6 条：foldBacklog 会话一条不丢，较早的合成一条', () => {
    for (let i = 0; i < 6; i++) store(i); // 第一轮
    for (let i = 6; i < 12; i++) store(i); // 第二轮，agent 还没消费第一轮
    const pending = getPendingMessages(JID, '', group(true), 'Andy', 10);
    expect(pending).toHaveLength(10);
    expect(pending[0].content).toContain('[补收：以下 3 条是较早未处理的消息]');
    for (const i of [0, 1, 2])
      expect(pending[0].content).toContain(`张三：第${i}条`);
    expect(pending.slice(1).map((m) => m.content)).toEqual(
      Array.from({ length: 9 }, (_, i) => `第${i + 3}条`),
    );
    // 游标推进到最后一条后，没有剩余
    expect(
      getPendingMessages(JID, pending[9].timestamp, group(true), 'Andy', 10),
    ).toEqual([]);
  });

  it('普通群保持原行为：只取最新 maxBatch 条', () => {
    for (let i = 0; i < 12; i++) store(i);
    const pending = getPendingMessages(JID, '', group(false), 'Andy', 10);
    expect(pending.map((m) => m.content)).toEqual(
      Array.from({ length: 10 }, (_, i) => `第${i + 2}条`),
    );
  });
});
