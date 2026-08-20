import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { mergeInitialPromptWithPending, mergeIpcMessages, pushMergedIpcMessage } from './ipc-message-batch.js';

describe('mergeIpcMessages', () => {
  it('按 IPC 顺序合并文字并生成批次内唯一附件标签', () => {
    const merged = mergeIpcMessages([
      {
        text: '第一批',
        attachments: [
          { type: 'image', path: '/group/a.jpg', label: '消息1-图片1' },
          { type: 'image', path: '/group/b.jpg', label: '消息1-图片2' },
          { type: 'image', path: '/group/c.jpg', label: '消息2-图片1' },
        ],
      },
      {
        text: '第二批',
        senderId: 'sender-2',
        modelOverride: { model: 'new-model' },
        context: { wiki: ['last'] },
        attachments: [
          { type: 'image', path: '/group/d.jpg', label: '消息1-图片1' },
          { type: 'image', path: '/group/e.jpg', label: '消息1-图片2' },
        ],
      },
    ]);

    expect(merged).toEqual({
      text: '第一批\n第二批',
      senderId: 'sender-2',
      modelOverride: { model: 'new-model' },
      context: { wiki: ['last'] },
      messageCount: 3,
      attachments: [
        { type: 'image', path: '/group/a.jpg', label: '消息1-图片1' },
        { type: 'image', path: '/group/b.jpg', label: '消息1-图片2' },
        { type: 'image', path: '/group/c.jpg', label: '消息2-图片1' },
        { type: 'image', path: '/group/d.jpg', label: '消息3-图片1' },
        { type: 'image', path: '/group/e.jpg', label: '消息3-图片2' },
      ],
    });
  });

  it('纯文字消息也占消息编号，后续图片不串到前一条文字', () => {
    const merged = mergeIpcMessages([
      { text: '只有文字' },
      {
        text: '第二条带图',
        attachments: [{ type: 'image', path: '/group/a.jpg', label: '消息1-图片1' }],
      },
    ]);

    expect(merged.attachments).toEqual([{ type: 'image', path: '/group/a.jpg', label: '消息2-图片1' }]);
    expect(merged.messageCount).toBe(2);
  });

  it('IPC 内尾部纯文字由显式 messageCount 占位，下一批图片不冲突', () => {
    const merged = mergeIpcMessages([
      {
        text: '第一批含图后纯文字',
        messageCount: 2,
        attachments: [{ type: 'image', path: '/group/a.jpg', label: '消息1-图片1' }],
      },
      {
        text: '第二批带图',
        messageCount: 1,
        attachments: [{ type: 'image', path: '/group/b.jpg', label: '消息1-图片1' }],
      },
    ]);

    expect(merged.attachments.map(attachment => attachment.label)).toEqual(['消息1-图片1', '消息3-图片1']);
    expect(merged.messageCount).toBe(3);
  });

  it('启动 pending 合并保留初始附件和 pending 附件的归属', () => {
    const merged = mergeInitialPromptWithPending(
      '初始消息',
      [{ type: 'image', path: '/group/a.jpg', label: '消息1-图片1' }],
      [
        { text: '纯文字 pending' },
        {
          text: '带图 pending',
          attachments: [{ type: 'image', path: '/group/b.jpg', label: '消息1-图片1' }],
        },
      ],
    );

    expect(merged.text).toBe('初始消息\n纯文字 pending\n带图 pending');
    expect(merged.messageCount).toBe(3);
    expect(merged.attachments.map(attachment => attachment.label)).toEqual(['消息1-图片1', '消息3-图片1']);
  });

  it('active 批次只向 MessageStream push 一帧且包含全部图片', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-images-'));
    try {
      const first = path.join(root, 'first.jpg');
      const second = path.join(root, 'second.jpg');
      fs.writeFileSync(first, Buffer.from([0xff, 0xd8, 0xff, 0x01]));
      fs.writeFileSync(second, Buffer.from([0xff, 0xd8, 0xff, 0x02]));
      const merged = mergeIpcMessages([
        {
          text: '第一条',
          attachments: [{ type: 'image', path: first, label: '消息1-图片1' }],
        },
        {
          text: '第二条',
          attachments: [{ type: 'image', path: second, label: '消息1-图片1' }],
        },
      ]);
      const pushed: unknown[] = [];

      const diagnostics = await pushMergedIpcMessage({ push: content => pushed.push(content) }, merged, { allowedRoot: root });

      expect(pushed).toHaveLength(1);
      expect((pushed[0] as any[]).filter(block => block.type === 'image')).toHaveLength(2);
      expect(diagnostics).toMatchObject({ native: 2, fallback: 0, skipped: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
