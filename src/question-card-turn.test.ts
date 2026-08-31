import { describe, expect, it, vi } from 'vitest';

import { QuestionCardTurnQueue } from './question-card-turn.js';

describe('QuestionCardTurnQueue', () => {
  it('等待正在执行的更新后发送终态，并跳过排队及后续更新', async () => {
    const events: string[] = [];
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    const queue = new QuestionCardTurnQueue(vi.fn());

    const first = queue.enqueueUpdate(async () => {
      events.push('update:start');
      await running;
      events.push('update:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['update:start']));
    const stale = queue.enqueueUpdate(async () => {
      events.push('stale:update');
    });
    const terminal = queue.enqueueTerminal(async () => {
      events.push('terminal');
      return 'card-id';
    });
    const late = queue.enqueueUpdate(async () => {
      events.push('late:update');
    });

    releaseRunning();
    await expect(terminal).resolves.toBe('card-id');
    await Promise.all([first, stale, late, queue.wait()]);
    expect(events).toEqual(['update:start', 'update:end', 'terminal']);
  });

  it('终态失败会返回调用方，同时队列仍可正常收口', async () => {
    const onError = vi.fn();
    const queue = new QuestionCardTurnQueue(onError);

    await expect(
      queue.enqueueTerminal(async () => {
        throw new Error('发送失败');
      }),
    ).rejects.toThrow('发送失败');
    await queue.wait();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('终态失败后恢复普通更新，保证文字兜底不会被吞', async () => {
    const events: string[] = [];
    const queue = new QuestionCardTurnQueue(vi.fn());

    const terminal = queue.enqueueTerminal(async () => {
      events.push('terminal');
      throw new Error('发送失败');
    });
    const fallback = queue.enqueueUpdate(async () => {
      events.push('fallback');
    });

    await expect(terminal).rejects.toThrow('发送失败');
    await fallback;
    expect(events).toEqual(['terminal', 'fallback']);
  });

  it('仅在终态发送成功后标记已向用户输出', async () => {
    const onTerminalSuccess = vi.fn();
    const queue = new QuestionCardTurnQueue(vi.fn(), onTerminalSuccess);

    await expect(queue.enqueueTerminal(async () => 'card-id')).resolves.toBe(
      'card-id',
    );
    expect(onTerminalSuccess).toHaveBeenCalledOnce();

    await expect(
      queue.enqueueTerminal(async () => {
        throw new Error('发送失败');
      }),
    ).rejects.toThrow('发送失败');
    expect(onTerminalSuccess).toHaveBeenCalledOnce();
  });
});
