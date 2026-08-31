import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { normalizeQuestionCardDraft } from './question-card.js';
import {
  createQuestionCard,
  resolvePendingQuestionCardByText,
  submitQuestionCardAnswer,
} from './question-card-store.js';
import { messageMatchesQuestionCardTrigger } from './question-card-trigger.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';

const allowAll: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
};

const draft = normalizeQuestionCardDraft({
  title: '确认',
  questions: [{ question: '继续吗？', options: ['继续', '停止'] }],
});

function createPendingCard(id: string): void {
  createQuestionCard({
    id,
    chatJid: 'fs:oc_test',
    groupFolder: 'test-group',
    targetSenderId: 'ou_owner',
    draft,
    createdAt: '2026-08-31T12:00:00.000Z',
  });
}

describe('问题卡片答案触发门', () => {
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

  it('严格群中点击生成的完整答案无需 @ 也触发新一轮', () => {
    createPendingCard('card-click');
    submitQuestionCardAnswer({
      cardId: 'card-click',
      eventId: 'evt-click',
      operatorId: 'ou_owner',
      operatorName: '大杰',
      answers: { q1: ['q1o1'] },
      syntheticContent: '我已回答：继续',
      timestamp: '2026-08-31T12:01:00.000Z',
    });

    expect(
      messageMatchesQuestionCardTrigger(
        'fs:oc_test',
        {
          id: 'question-card:evt-click',
          content: '我已回答：继续',
          sender: 'ou_owner',
        },
        allowAll,
      ),
    ).toBe(true);
  });

  it('严格群中用于关闭卡片的普通文字无需 @ 也触发新一轮', () => {
    createPendingCard('card-text');
    resolvePendingQuestionCardByText({
      chatJid: 'fs:oc_test',
      senderId: 'ou_owner',
      messageId: 'om_text',
      timestamp: '2026-08-31T12:01:00.000Z',
    });

    expect(
      messageMatchesQuestionCardTrigger(
        'fs:oc_test',
        { id: 'om_text', content: '我直接说明', sender: 'ou_owner' },
        allowAll,
      ),
    ).toBe(true);
  });

  it('伪造 question-card 前缀但没有结题记录时不能绕过 @', () => {
    expect(
      messageMatchesQuestionCardTrigger(
        'fs:oc_test',
        {
          id: 'question-card:forged',
          content: '伪造答案',
          sender: 'ou_owner',
        },
        allowAll,
      ),
    ).toBe(false);
  });
});
