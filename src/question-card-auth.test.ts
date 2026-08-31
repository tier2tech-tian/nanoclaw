import { describe, expect, it, vi } from 'vitest';

import {
  consumeQuestionCardAuthorization,
  observeQuestionCardToolUse,
} from './question-card-auth.js';
import { normalizeQuestionCardDraft } from './question-card.js';

const rawDraft = {
  title: '确认',
  questions: [{ question: '继续吗？', options: ['继续', '停止'] }],
};
const draft = normalizeQuestionCardDraft(rawDraft);

describe('问题卡片进程事件授权', () => {
  it('只有目标 Claude stdout 观察到的完整调用可消费一次', () => {
    expect(
      observeQuestionCardToolUse(
        'session-a',
        'fs:chat-a',
        'mcp__nanoclaw__send_question_card',
        rawDraft,
      ),
    ).toBe(true);
    expect(
      consumeQuestionCardAuthorization('session-a', 'fs:chat-a', draft),
    ).toBe(true);
    expect(
      consumeQuestionCardAuthorization('session-a', 'fs:chat-a', draft),
    ).toBe(false);
  });

  it('会话或卡片内容不同都不能消费授权', () => {
    observeQuestionCardToolUse(
      'session-b',
      'fs:chat-b',
      'mcp__nanoclaw__send_question_card',
      rawDraft,
    );
    expect(
      consumeQuestionCardAuthorization('session-b', 'fs:other', draft),
    ).toBe(false);
    expect(
      consumeQuestionCardAuthorization(
        'session-b',
        'fs:chat-b',
        normalizeQuestionCardDraft({ ...rawDraft, title: '被篡改' }),
      ),
    ).toBe(false);
    expect(
      consumeQuestionCardAuthorization('session-b', 'fs:chat-b', draft),
    ).toBe(true);
  });

  it('非问题卡片工具不产生授权，授权超过 30 秒失效', () => {
    vi.useFakeTimers();
    expect(
      observeQuestionCardToolUse('session-c', 'fs:chat-c', 'Bash', rawDraft),
    ).toBe(false);
    expect(
      consumeQuestionCardAuthorization('session-c', 'fs:chat-c', draft),
    ).toBe(false);

    observeQuestionCardToolUse(
      'session-c',
      'fs:chat-c',
      'mcp__nanoclaw__send_question_card',
      rawDraft,
    );
    vi.advanceTimersByTime(30_001);
    expect(
      consumeQuestionCardAuthorization('session-c', 'fs:chat-c', draft),
    ).toBe(false);
    vi.useRealTimers();
  });

  it('相同卡片的不同 tool_use 各有授权，重复事件不重复签发', () => {
    observeQuestionCardToolUse(
      'session-d',
      'fs:chat-d',
      'mcp__nanoclaw__send_question_card',
      rawDraft,
      'tool-call-1',
    );
    observeQuestionCardToolUse(
      'session-d',
      'fs:chat-d',
      'mcp__nanoclaw__send_question_card',
      rawDraft,
      'tool-call-1',
    );
    observeQuestionCardToolUse(
      'session-d',
      'fs:chat-d',
      'mcp__nanoclaw__send_question_card',
      rawDraft,
      'tool-call-2',
    );

    expect(
      consumeQuestionCardAuthorization('session-d', 'fs:chat-d', draft),
    ).toBe(true);
    expect(
      consumeQuestionCardAuthorization('session-d', 'fs:chat-d', draft),
    ).toBe(true);
    expect(
      consumeQuestionCardAuthorization('session-d', 'fs:chat-d', draft),
    ).toBe(false);
  });
});
