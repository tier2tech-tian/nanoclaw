import { expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveCodexAsNotice, flushCodexAsNotices } from './codex-as-notice.js';

it('发送失败保留通知，后续只补发通知并在成功后删除', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-notice-'));
  try {
    const file = saveCodexAsNotice(root, '执行结果未确认');
    await expect(
      flushCodexAsNotices(root, async () => {
        throw new Error('发送失败');
      }),
    ).rejects.toThrow('发送失败');
    expect(fs.existsSync(file)).toBe(true);
    const sent: string[] = [];
    await flushCodexAsNotices(root, async (text) => {
      sent.push(text);
    });
    await flushCodexAsNotices(root, async (text) => {
      sent.push(text);
    });
    expect(sent).toEqual(['执行结果未确认']);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(root, 'input'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
