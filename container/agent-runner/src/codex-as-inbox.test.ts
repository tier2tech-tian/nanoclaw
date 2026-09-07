import { afterEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexAsInbox } from './codex-as-inbox.js';

const roots: string[] = [];
function inbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-inbox-'));
  roots.push(root);
  return new CodexAsInbox(root);
}
afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

it('只有未发送认领可以恢复，发送状态不明的原文留在隔离区', () => {
  const box = inbox();
  box.seed('未发出');
  const sent = box.seed('已发出');
  box.submitted(sent);
  box.recoverUnsent();
  expect(box.claim()?.text).toBe('未发出');
  expect(box.claim()).toBeNull();
  expect(box.pendingUncertain()).toBe(1);
  expect(fs.readFileSync(sent.claimPath!, 'utf8')).toContain('已发出');
});

it('初始输入认领恢复保留 thinking、sender 和附件', () => {
  const box = inbox();
  const input = { senderId: 'sender', modelOverride: { model: 'model', thinking: 'disabled' as const }, attachments: [{ type: 'image', path: '/group/image.png' }] };
  box.seed('完整输入', input);
  box.recoverUnsent();
  expect(box.claim(true)).toMatchObject({ text: '完整输入', ...input });
});

it('模型变更消息不能在运行中越序消费，轮间允许认领', () => {
  const box = inbox();
  fs.writeFileSync(
    path.join(box.inputDir, '1.json'),
    JSON.stringify({
      type: 'message',
      text: '换模型',
      modelOverride: { model: 'model' },
    }),
  );
  fs.writeFileSync(
    path.join(box.inputDir, '2.json'),
    JSON.stringify({ type: 'message', text: '后一条' }),
  );
  expect(box.claim()).toBeNull();
  expect(box.claim(true)?.text).toBe('换模型');
  expect(box.claim()?.text).toBe('后一条');
});

it('接受后删除原文且不被重启恢复，回队不覆盖新文件', () => {
  const box = inbox();
  const sent = box.seed('完成');
  box.submitted(sent);
  box.accepted(sent);
  box.recoverUnsent();
  expect(box.pendingUncertain()).toBe(0);
  expect(box.claim()).toBeNull();
  const old = box.seed('旧');
  fs.writeFileSync(
    path.join(box.inputDir, path.basename(old.claimPath!)),
    JSON.stringify({ type: 'message', text: '新' }),
  );
  box.requeue(old.claimPath!);
  expect([box.claim()?.text, box.claim()?.text].sort()).toEqual(
    ['新', '旧'].sort(),
  );
});
