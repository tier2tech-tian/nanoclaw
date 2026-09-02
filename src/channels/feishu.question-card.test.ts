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

  it('多题卡点选只更新选中态，统一提交后才生成新消息', async () => {
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
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });

    const select = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-select',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    });

    expect(select.toast.type).toBe('success');
    expect(getQuestionCard(cardId)?.status).toBe('pending');
    expect(getNewMessages([chatJid], '', '大狗').messages).toHaveLength(0);
    const selectedCard = JSON.parse(
      patchMessage.mock.calls.at(-1)?.[0].data.content,
    );
    expect(JSON.stringify(selectedCard)).toContain('● 明天');

    const clickOption = async (optionId: string) => {
      const currentCard = JSON.parse(
        patchMessage.mock.calls.at(-1)?.[0].data.content,
      );
      const button = currentCard.body.elements.find(
        (element: any) => element.behaviors?.[0]?.value?.optionId === optionId,
      );
      return (channel as any).handleQuestionCardAction({
        event_id: `evt-${optionId}`,
        action: { value: button.behaviors[0].value },
        operator: { open_id: 'ou_owner' },
      });
    };
    await clickOption('q2o1');
    await clickOption('q2o3');

    const completedCard = JSON.parse(
      patchMessage.mock.calls.at(-1)?.[0].data.content,
    );
    const submitButton = completedCard.body.elements.at(-1);
    expect(submitButton.disabled).toBe(false);
    const submit = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-submit',
      action: { value: submitButton.behaviors[0].value },
      operator: { open_id: 'ou_owner' },
    });

    expect(submit.toast.type).toBe('success');
    expect(getQuestionCard(cardId)?.status).toBe('answered');
    expect(getNewMessages([chatJid], '', '大狗').messages[0].content).toContain(
      '通知谁？ → 研发、测试',
    );
  });

  it('同一次点选被重复投递时幂等成功，不要求用户重新选择', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    const payload = {
      event_id: 'evt-duplicate-select',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
          selected: true,
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    };

    expect(
      (await (channel as any).handleQuestionCardAction(payload)).toast,
    ).toMatchObject({ type: 'success', content: '已选择' });
    const patchCount = patchMessage.mock.calls.length;
    expect(
      (await (channel as any).handleQuestionCardAction(payload)).toast,
    ).toMatchObject({ type: 'success', content: '已选择' });
    expect(patchMessage).toHaveBeenCalledTimes(patchCount);
    expect(getQuestionCard(cardId)).toMatchObject({
      selectionAnswers: { q1: ['q1o2'] },
      selectionRevision: 1,
    });
  });

  it('飞书将 selected 转成字符串后重复投递仍幂等成功', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    const payload = {
      event_id: 'evt-stringified-select',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
          selected: 'true',
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    };

    expect(
      (await (channel as any).handleQuestionCardAction(payload)).toast,
    ).toMatchObject({ type: 'success', content: '已选择' });
    const patchCount = patchMessage.mock.calls.length;
    expect(
      (await (channel as any).handleQuestionCardAction(payload)).toast,
    ).toMatchObject({ type: 'success', content: '已选择' });
    expect(patchMessage).toHaveBeenCalledTimes(patchCount);
    expect(getQuestionCard(cardId)).toMatchObject({
      selectionAnswers: { q1: ['q1o2'] },
      selectionRevision: 1,
    });
  });

  it('同一次点选并发重复投递时只提交一次且都返回成功', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    const click = () =>
      (channel as any).handleQuestionCardAction({
        event_id: 'evt-concurrent-duplicate',
        action: {
          value: {
            action: 'question_card_select',
            cardId,
            questionId: 'q1',
            optionId: 'q1o2',
            selected: true,
            revision: 0,
          },
        },
        operator: { open_id: 'ou_owner' },
      });

    const responses = await Promise.all([click(), click()]);
    expect(responses.map((response) => response.toast.type)).toEqual([
      'success',
      'success',
    ]);
    expect(getQuestionCard(cardId)).toMatchObject({
      selectionAnswers: { q1: ['q1o2'] },
      selectionRevision: 1,
    });
  });

  it('乱序回调中的未知选项仍被拒绝', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    await (channel as any).handleQuestionCardAction({
      event_id: 'evt-valid-select',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
          selected: true,
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    });

    const response = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-invalid-stale-select',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'unknown',
          selected: false,
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    });

    expect(response.toast).toMatchObject({ type: 'warning', content: '无效选项' });
  });

  it('卡片 PATCH 失败时不落选择状态，也不假报成功', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    patchMessage.mockRejectedValueOnce(new Error('patch failed'));
    patchMessage.mockRejectedValueOnce(new Error('patch failed'));

    const response = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-failed-patch',
      action: {
        value: {
          action: 'question_card_select',
          cardId,
          questionId: 'q1',
          optionId: 'q1o2',
          revision: 0,
        },
      },
      operator: { open_id: 'ou_owner' },
    });

    expect(response.toast.type).toBe('warning');
    expect(getQuestionCard(cardId)).toMatchObject({
      selectionAnswers: {},
      selectionRevision: 0,
    });
  });

  it('同一版本快速连点时只接受一次，迟到回调不能覆盖已选项', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    const click = (questionId: string, optionId: string) =>
      (channel as any).handleQuestionCardAction({
        event_id: `evt-${optionId}`,
        action: {
          value: {
            action: 'question_card_select',
            cardId,
            questionId,
            optionId,
            revision: 0,
          },
        },
        operator: { open_id: 'ou_owner' },
      });

    const [first, second] = await Promise.all([
      click('q1', 'q1o2'),
      click('q2', 'q2o1'),
    ]);

    expect(first.toast.type).toBe('success');
    expect(second.toast.type).toBe('info');
    expect(getQuestionCard(cardId)).toMatchObject({
      selectionAnswers: { q1: ['q1o2'] },
      selectionRevision: 1,
    });
    const refreshed = patchMessage.mock.calls.at(-1)?.[0].data.content;
    expect(refreshed).toContain('● 明天');
    expect(refreshed).toContain('□ 研发');
  });

  it('并发修复 PATCH 失败时推进版本，旧界面不能提交错位答案', async () => {
    const channel = new FeishuChannel(
      'app-id',
      'app-secret',
      makeOpts() as any,
    );
    const formDraft = normalizeQuestionCardDraft({
      title: '发布确认',
      questions: [
        { question: '发布窗口？', options: ['现在', '明天'] },
        { question: '通知谁？', multi: true, options: ['研发', '产品'] },
      ],
    });
    const cardId = await channel.sendQuestionCard(chatJid, {
      groupFolder: 'test-agent',
      targetSenderId: 'ou_owner',
      draft: formDraft,
    });
    patchMessage
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('repair failed'))
      .mockRejectedValueOnce(new Error('repair failed'));
    const click = (questionId: string, optionId: string) =>
      (channel as any).handleQuestionCardAction({
        event_id: `evt-${optionId}`,
        action: {
          value: {
            action: 'question_card_select',
            cardId,
            questionId,
            optionId,
            revision: 0,
          },
        },
        operator: { open_id: 'ou_owner' },
      });

    const [first, second] = await Promise.all([
      click('q1', 'q1o2'),
      click('q2', 'q2o1'),
    ]);

    expect(first.toast.type).toBe('success');
    expect(second.toast.type).toBe('warning');
    expect(getQuestionCard(cardId)?.selectionRevision).toBe(2);
    const staleSubmit = await (channel as any).handleQuestionCardAction({
      event_id: 'evt-stale-submit',
      action: {
        value: {
          action: 'question_card_submit',
          cardId,
          revision: 1,
        },
      },
      operator: { open_id: 'ou_owner' },
    });
    expect(staleSubmit.toast.content).toContain('重新提交');
    expect(getQuestionCard(cardId)?.status).toBe('pending');
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
