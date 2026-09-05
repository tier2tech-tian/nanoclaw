import { describe, expect, it, vi } from 'vitest';

import {
  createActiveQuestionCardTurn,
  sendQuestionCardForTurn,
  withActiveQuestionCardTurn,
  type ActiveQuestionCardTurn,
} from './question-card-active-turn.js';

describe('createActiveQuestionCardTurn', () => {
  it('活跃轮发卡不再需要提问人身份', async () => {
    const send = vi.fn().mockResolvedValue('card-1');
    const turn = createActiveQuestionCardTurn(send);

    await turn.sendQuestionCard('group-folder', {
      title: '发布方式确认',
      questions: [
        {
          id: 'q1',
          question: '选择发布方式',
          multi: false,
          options: [
            { id: 'q1o1', label: '灰度发布', recommended: true },
            { id: 'q1o2', label: '全量发布', recommended: false },
          ],
        },
      ],
    });

    expect(send).toHaveBeenCalledWith('group-folder', expect.any(Object));
  });

  it('进程超过一小时发卡后异常退出，仍记账且清理活跃记录', async () => {
    vi.useFakeTimers();
    try {
      const draft = { title: '继续确认', questions: [] };
      let everSentToUser = false;
      const activeSend = vi.fn(async () => {
        everSentToUser = true;
        return 'active-card';
      });
      const fallbackSend = vi.fn().mockResolvedValue('new-card');
      const turns = new Map<string, ActiveQuestionCardTurn>();
      const turn = createActiveQuestionCardTurn(activeSend);
      const run = withActiveQuestionCardTurn(turns, 'chat', turn, async () => {
        await new Promise((resolve) => setTimeout(resolve, 60 * 60 * 1000 + 1));
        await sendQuestionCardForTurn(
          turns.get('chat'),
          'group',
          draft,
          fallbackSend,
        );
        throw new Error('进程异常退出');
      });
      const rejected = expect(run).rejects.toThrow('进程异常退出');
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
      await rejected;
      expect(everSentToUser).toBe(true);
      expect(turns.has('chat')).toBe(false);
      expect(activeSend).toHaveBeenCalledOnce();
      expect(fallbackSend).not.toHaveBeenCalled();
      expect(
        await sendQuestionCardForTurn(undefined, 'group', draft, fallbackSend),
      ).toBe('new-card');
      expect(fallbackSend).toHaveBeenCalledWith('group', draft);
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常退出清理记录，旧进程退出不删除新进程记录', async () => {
    const turns = new Map<string, ActiveQuestionCardTurn>();
    const oldTurn = createActiveQuestionCardTurn(vi.fn());
    const newTurn = createActiveQuestionCardTurn(vi.fn());
    expect(
      await withActiveQuestionCardTurn(turns, 'chat', oldTurn, async () => {
        expect(turns.get('chat')).toBe(oldTurn);
        return 'done';
      }),
    ).toBe('done');
    expect(turns.has('chat')).toBe(false);
    await withActiveQuestionCardTurn(turns, 'chat', oldTurn, async () => {
      turns.set('chat', newTurn);
    });
    expect(turns.get('chat')).toBe(newTurn);
  });
});
