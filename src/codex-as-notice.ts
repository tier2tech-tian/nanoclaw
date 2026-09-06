import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** 通知失败只保留通知；不得因此重新执行原任务。 */
export function saveCodexAsNotice(ipcDir: string, text: string): string {
  const dir = path.join(ipcDir, 'codex-as-notices');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ text }), { flag: 'wx' });
  return file;
}

export async function flushCodexAsNotices(
  ipcDir: string,
  send: (text: string) => Promise<unknown>,
): Promise<void> {
  const dir = path.join(ipcDir, 'codex-as-notices');
  if (!fs.existsSync(dir)) return;
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const file = path.join(dir, name);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.text !== 'string')
      throw new Error('codex-as 待发送通知格式错误');
    await send(data.text);
    fs.unlinkSync(file);
  }
}
