import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMessage = vi
  .fn()
  .mockResolvedValue({ data: { message_id: 'om_question' } });
const patchMessage = vi.fn().mockResolvedValue({});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    im = {
      message: {
        create: createMessage,
        patch: patchMessage,
        delete: vi.fn(),
      },
      messageReaction: { create: vi.fn(), delete: vi.fn() },
      chatMembers: {
        get: vi.fn().mockResolvedValue({
          data: { items: [{ member_id: 'ou_owner', name: '大杰' }] },
        }),
      },
    };
  }
  class MockWSClient {}
  class MockEventDispatcher {
    register() {
      return this;
    }
  }
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    Domain: { Feishu: 'feishu' },
    LoggerLevel: { info: 1, warn: 2 },
  };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/groups/${folder}`,
}));
vi.mock('../voice-notify.js', () => ({ notifyVoice: vi.fn() }));

import { _initTestDatabase, getNewMessages, storeChatMetadata } from '../db.js';
import { normalizeQuestionCardDraft } from '../question-card.js';
import {
  getQuestionCard,
  getQuestionCardByMessageId,
} from '../question-card-store.js';
import { FeishuChannel } from './feishu.js';

const chatJid = 'fs:oc_test';
const draft = normalizeQuestionCardDraft({
  title: '发布确认',
  questions: [
    { question: '发布窗口？', options: ['现在', '明天'], recommended: [1] },
  ],
});

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({
      [chatJid]: {
        name: '测试群',
        folder: 'test-agent',
        trigger: 'always',
        added_at: new Date().toISOString(),
      },
    }),
  };
}

describe('飞书问题表单卡片', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(
      chatJid,
      new Date().toISOString(),
      '测试群',
      'feishu',
      true,
    );
    vi.clearAllMocks();
    createMessage.mockResolvedValue({ data: { message_id: 'om_question' } });
  });

  it('发送前持久化，成功后绑定 message_id，推荐项不预选', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft,
    });

    expect(getQuestionCard(cardId)?.messageId).toBe('om_question');
    const card = JSON.parse(createMessage.mock.calls[0][0].data.content);
    expect(JSON.stringify(card)).toContain('（推荐）');
    expect(JSON.stringify(card)).not.toContain('checked');
  });

  it('目标用户首次提交写入完整新消息，重复点击不重复入库', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft,
    });

    const denied = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-denied',
      action: {
        value: {
          action: 'question_card',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
        },
      },
      operator: { open_id: 'ou_other' },
    });
    expect(denied.toast.type).toBe('warning');

    const submit = () =>
      (channel as any).handleQuestionCardAction({
        event_id: 'evt-ok',
        action: {
          value: {
            action: 'question_card',
            cardId,
            questionId: 'q1',
            optionId: 'q1o2',
          },
        },
        operator: { open_id: 'ou_owner' },
      });
    expect((await submit()).toast.type).toBe('success');
    expect((await submit()).toast.type).toBe('info');

    const polled = getNewMessages([chatJid], '', '大狗');
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0].content).toContain('发布窗口？ → 明天');
  });

  it('Card 2.0 表单回调解析单选和多选完整答案', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        {
          question: '通知谁？',
          multi: true,
          options: ['研发', '产品', '测试'],
        },
      ],
    });
    await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });

    const response = await (channel as any).handleQuestionCardAction({
      event: {
        event_id: 'evt-form',
        context: { open_message_id: 'om_question' },
        operator: { open_id: 'ou_owner' },
        action: {
          form_value: JSON.stringify({
            q1: 'q1o2',
            q2__q2o1: true,
            q2__q2o2: false,
            q2__q2o3: true,
          }),
        },
      },
    });

    expect(response.toast.type).toBe('success');
    expect(getNewMessages([chatJid], '', '大狗').messages[0].content).toContain(
      '通知谁？ → 研发、测试',
    );
  });

  it('普通文字先关闭待答卡片，再继续正常消息链路', async () => {
    const opts = makeOpts();
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft,
    });

    await (channel as any).handleMessage({
      sender: {
        sender_id: { open_id: 'ou_owner' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_text',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '我直接说明情况' }),
      },
    });

    expect(getQuestionCard(cardId)?.status).toBe('text_replied');
    expect(getQuestionCardByMessageId('om_question')?.resolvedMessageId).toBe(
      'om_text',
    );
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('已有进度卡时等待旧 PATCH 排空后原位替换', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    let releasePatch!: () => void;
    const pendingPatch = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    (channel as any).progressCards.set(chatJid, {
      messageId: 'om_progress',
      sessionId: 'session',
      steps: [],
      allSteps: [],
      frame: 0,
      startTime: Date.now(),
      patchLoopPromise: pendingPatch,
      patchInFlight: true,
    });

    const sending = channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft,
    });
    await Promise.resolve();
    expect(patchMessage).not.toHaveBeenCalled();
    releasePatch();
    const cardId = await sending;

    expect(createMessage).not.toHaveBeenCalled();
    expect(patchMessage).toHaveBeenCalledWith(
      expect.objectContaining({ path: { message_id: 'om_progress' } }),
    );
    expect(getQuestionCard(cardId)?.messageId).toBe('om_progress');
  });
});
