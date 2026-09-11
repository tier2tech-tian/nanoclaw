import { it, expect } from 'vitest';
import { isCodexAccountSwitch } from './cli-mode.js';

it('仅Codex切到不同账号时阻止旧任务进入新账号重试', () => {
  expect(isCodexAccountSwitch('codex', undefined, 'backup')).toBe(true);
  expect(isCodexAccountSwitch('codex-as', 'backup', 'system')).toBe(true);
  expect(isCodexAccountSwitch('codex', undefined, 'system')).toBe(false);
  expect(isCodexAccountSwitch('codex', 'backup', 'backup')).toBe(false);
  expect(isCodexAccountSwitch('sdk', undefined, 'backup')).toBe(false);
});
