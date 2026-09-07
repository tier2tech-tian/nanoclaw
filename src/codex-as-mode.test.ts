import { describe, expect, it } from 'vitest';
import {
  resolveCliMode,
  shouldAutoRotateAnthropicAccount,
} from './cli-mode.js';

describe('codex-as 模式隔离', () => {
  it('接受独立模式而不改变旧模式或默认值', () => {
    expect(resolveCliMode({ cliMode: 'codex-as' } as any)).toBe('codex-as');
    expect(resolveCliMode({ cliMode: 'codex' })).toBe('codex');
    expect(resolveCliMode()).toBe('sdk');
    expect(shouldAutoRotateAnthropicAccount('codex-as' as any)).toBe(false);
  });
});
