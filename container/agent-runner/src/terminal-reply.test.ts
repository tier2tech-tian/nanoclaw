import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTerminalReplyMarker,
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
  it('只消费一次', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);
    expect(clearTerminalReplyMarker(dir)).toBe(true);
    expect(clearTerminalReplyMarker(dir)).toBe(false);
  });

  it('启动清理幂等', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    clearTerminalReplyMarker(dir);
    writeTerminalReplyMarker(dir);
    clearTerminalReplyMarker(dir);
    expect(clearTerminalReplyMarker(dir)).toBe(false);
  });

  it('发卡后把本轮空正文标为终态并立即消费 marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);
    expect(
      suppressTerminalReplyOutput(dir, {
        status: 'success' as const,
        result: null,
        newSessionId: 'session-1',
      }),
    ).toEqual({
      suppressed: true,
      output: {
        status: 'success',
        result: null,
        newSessionId: 'session-1',
        error: undefined,
        terminalReply: true,
      },
    });
    expect(clearTerminalReplyMarker(dir)).toBe(false);
  });

  it('error 不消费 marker，不能把真实错误吞成成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);
    expect(
      suppressTerminalReplyOutput(dir, {
        status: 'error' as const,
        result: null,
      }).suppressed,
    ).toBe(false);
    expect(clearTerminalReplyMarker(dir)).toBe(true);
  });
});
