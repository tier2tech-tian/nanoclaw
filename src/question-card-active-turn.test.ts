import { describe, expect, it, vi } from 'vitest';

import { createActiveQuestionCardTurn } from './question-card-active-turn.js';

describe('createActiveQuestionCardTurn', () => {
  it('长驻进程续接新用户消息后按当前发送者绑定卡片', async () => {
    const send = vi.fn().mockResolvedValue('card-1');
    const turn = createActiveQuestionCardTurn('debug', send);

    turn.senderId = 'ou_current_user';
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

    expect(send).toHaveBeenCalledWith(
      'group-folder',
      'ou_current_user',
      expect.any(Object),
    );
  });
});
