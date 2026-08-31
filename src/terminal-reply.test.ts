import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTerminalReplyMarker,
  hasTerminalReplyMarker,
  writeTerminalReplyMarker,
} from './terminal-reply.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('宿主机终态回复标记', () => {
  it('原子写入并只清理一次', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reply-'));
    dirs.push(dir);
    writeTerminalReplyMarker(dir);
    expect(hasTerminalReplyMarker(dir)).toBe(true);
    expect(clearTerminalReplyMarker(dir)).toBe(true);
    expect(clearTerminalReplyMarker(dir)).toBe(false);
    expect(hasTerminalReplyMarker(dir)).toBe(false);
  });
});
