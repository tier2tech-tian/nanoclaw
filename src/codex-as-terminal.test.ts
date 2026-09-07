import { expect, it } from 'vitest';
import { CodexAsTerminal } from './codex-as-terminal.js';

it('无输出或只有进度时强制退出必须失败', () => {
  const state = new CodexAsTerminal();
  expect(state.interrupted('超时').status).toBe('error');
  state.observe({ status: 'progress', result: '进行中' });
  expect(state.interrupted('超时').status).toBe('error');
});
it('明确终态后空闲清理保留终态，后继进度不能复用前轮成功', () => {
  const state = new CodexAsTerminal();
  state.observe({ status: 'success', result: '完成' });
  expect(state.interrupted('空闲关闭').status).toBe('success');
  state.observe({ status: 'progress', result: null });
  expect(state.interrupted('超时').status).toBe('error');
  state.observe({ status: 'error', result: '真实失败' });
  expect(state.interrupted('退出').status).toBe('error');
});
