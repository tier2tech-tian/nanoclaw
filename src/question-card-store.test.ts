import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getNewMessages,
  getMessagesSince,
  storeChatMetadata,
} from './db.js';
import { normalizeQuestionCardDraft } from './question-card.js';
import {
  attachQuestionCardMessage,
  createQuestionCard,
  getQuestionCard,
  getQuestionCardByMessageId,
  resolvePendingQuestionCardByText,
  submitQuestionCardAnswer,
} from './question-card-store.js';

const draft = normalizeQuestionCardDraft({
  title: '发布确认',
  questions: [
    {
      question: '发布窗口？',
      multi: false,
      options: ['现在', '明天'],
      recommended: [1],
    },
  ],
});

function createPendingCard(id = 'card-1') {
  createQuestionCard({
    id,
    chatJid: 'fs:oc_test',
    groupFolder: 'test-group',
    targetSenderId: 'ou_owner',
    draft,
    createdAt: '2026-08-31T12:00:00.000Z',
  });
}

describe('问题卡片持久状态', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(
      'fs:oc_test',
      '2026-08-31T11:59:00.000Z',
      '测试群',
      'feishu',
      true,
    );
  });

  it('持久化待答卡片并绑定飞书 message_id', () => {
    createPendingCard();
    attachQuestionCardMessage('card-1', 'om_card_1');

    expect(getQuestionCard('card-1')).toMatchObject({
      id: 'card-1',
      status: 'pending',
      messageId: 'om_card_1',
      targetSenderId: 'ou_owner',
      draft,
    });
    expect(getQuestionCardByMessageId('om_card_1')).toMatchObject({
      id: 'card-1',
      messageId: 'om_card_1',
    });
  });

  it('提交答案与合成用户消息原子落库，重复回调不重复触发', () => {
    createPendingCard();
    const first = submitQuestionCardAnswer({
      cardId: 'card-1',
      eventId: 'evt-1',
      operatorId: 'ou_owner',
      operatorName: '大杰',
      answers: { q1: ['q1o2'] },
      syntheticContent: '我已回答《发布确认》：\n1. 发布窗口？ → 明天',
      timestamp: '2026-08-31T12:01:00.000Z',
    });
    const repeated = submitQuestionCardAnswer({
      cardId: 'card-1',
      eventId: 'evt-1',
      operatorId: 'ou_owner',
      operatorName: '大杰',
      answers: { q1: ['q1o2'] },
      syntheticContent: '不应重复',
      timestamp: '2026-08-31T12:01:01.000Z',
    });

    expect(first.status).toBe('accepted');
    expect(repeated.status).toBe('already_resolved');
    expect(
      getNewMessages(
        ['fs:oc_test'],
        '2026-08-31T12:00:00.000Z',
        'Andy',
        10,
      ).messages,
    ).toMatchObject([
      {
        id: 'question-card:evt-1',
        content: '我已回答《发布确认》：\n1. 发布窗口？ → 明天',
      },
    ]);
    expect(
      getMessagesSince('fs:oc_test', '2026-08-31T12:00:00.000Z', 'Andy', 10),
    ).toMatchObject([
      {
        id: 'question-card:evt-1',
        sender: 'ou_owner',
        sender_name: '大杰',
        content: '我已回答《发布确认》：\n1. 发布窗口？ → 明天',
      },
    ]);
  });

  it('非目标用户不能提交', () => {
    createPendingCard();
    const result = submitQuestionCardAnswer({
      cardId: 'card-1',
      eventId: 'evt-other',
      operatorId: 'ou_other',
      operatorName: '路人',
      answers: { q1: ['q1o1'] },
      syntheticContent: '不应写入',
      timestamp: '2026-08-31T12:01:00.000Z',
    });

    expect(result.status).toBe('unauthorized');
    expect(getQuestionCard('card-1')?.status).toBe('pending');
    expect(
      getMessagesSince('fs:oc_test', '2026-08-31T12:00:00.000Z', 'Andy', 10),
    ).toEqual([]);
  });

  it('普通文字先到时关闭卡片，迟到点击不再生成合成消息', () => {
    createPendingCard();
    const closed = resolvePendingQuestionCardByText({
      chatJid: 'fs:oc_test',
      senderId: 'ou_owner',
      messageId: 'om_text_reply',
      timestamp: '2026-08-31T12:01:00.000Z',
    });
    const click = submitQuestionCardAnswer({
      cardId: 'card-1',
      eventId: 'evt-late',
      operatorId: 'ou_owner',
      operatorName: '大杰',
      answers: { q1: ['q1o2'] },
      syntheticContent: '不应写入',
      timestamp: '2026-08-31T12:01:01.000Z',
    });

    expect(closed.map((item) => item.id)).toEqual(['card-1']);
    expect(getQuestionCard('card-1')?.status).toBe('text_replied');
    expect(click.status).toBe('already_resolved');
    expect(
      getMessagesSince('fs:oc_test', '2026-08-31T12:00:00.000Z', 'Andy', 10),
    ).toEqual([]);
  });

  it('普通文字抢先关闭后，迟到的发卡结果仍能绑定 message_id', () => {
    createPendingCard();
    resolvePendingQuestionCardByText({
      chatJid: 'fs:oc_test',
      senderId: 'ou_owner',
      messageId: 'om_text_reply',
      timestamp: '2026-08-31T12:01:00.000Z',
    });

    attachQuestionCardMessage('card-1', 'om_late_card');

    expect(getQuestionCardByMessageId('om_late_card')).toMatchObject({
      id: 'card-1',
      status: 'text_replied',
    });
  });
});
