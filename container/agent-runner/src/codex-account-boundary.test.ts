import fs from 'fs';
import os from 'os';
import path from 'path';
import { it, expect } from 'vitest';
import { shouldRetireCodex } from './codex-account-boundary.js';

it('切号退出信号等已送入的消息处理完，不消费关闭信号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retire-'));
  try {
    fs.writeFileSync(path.join(dir, '_retire'), '');
    fs.writeFileSync(
      path.join(dir, '1.json'),
      JSON.stringify({ type: 'message', text: 'already sent' }),
    );
    expect(shouldRetireCodex(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, '_retire'))).toBe(true);
    fs.unlinkSync(path.join(dir, '1.json'));
    expect(shouldRetireCodex(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, '_close'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
