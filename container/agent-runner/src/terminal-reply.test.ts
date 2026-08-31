import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTerminalReplyMarker,
  consumeTerminalReplyMarker,
  suppressTerminalReplyOutput,
  writeTerminalReplyMarker,
} from './terminal-reply.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('终态回复标记', () => {
  it('只被消费一次，避免发卡后的重复文字终态', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);

    expect(consumeTerminalReplyMarker(dir)).toBe(true);
    expect(consumeTerminalReplyMarker(dir)).toBe(false);
  });

  it('启动清理不存在或遗留标记都幂等', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    clearTerminalReplyMarker(dir);
    writeTerminalReplyMarker(dir);
    clearTerminalReplyMarker(dir);
    expect(consumeTerminalReplyMarker(dir)).toBe(false);
  });

  it('卡片成功后把任意终态改成静默成功，并保留 session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);

    expect(
      suppressTerminalReplyOutput(dir, {
        status: 'success' as const,
        result: '卡片已发送，请选择',
        newSessionId: 'session-1',
      }),
    ).toEqual({
      suppressed: true,
      output: {
        status: 'success',
        result: null,
        newSessionId: 'session-1',
        usage: undefined,
      },
    });
  });
});
