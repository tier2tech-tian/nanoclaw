import { describe, expect, it } from 'vitest';

import { formatMessagesForAgent } from './multimodal-input.js';
import type { NewMessage } from './types.js';

const TZ = 'Asia/Shanghai';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'fs:oc_test',
    sender: 'ou_user',
    sender_name: '大杰',
    content: '看图',
    timestamp: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatMessagesForAgent', () => {
  it('Claude 模式按消息和附件顺序生成唯一标签并从 prompt 去掉成功候选路径', () => {
    const result = formatMessagesForAgent(
      [
        makeMessage({
          content:
            '一起看\n[图片: /group/images/a.jpg]\n[图片: /group/images/b.png]',
          attachments: [
            { type: 'image', path: '/group/images/a.jpg', source: 'feishu' },
            { type: 'image', path: '/group/images/b.png', source: 'feishu' },
          ],
        }),
      ],
      TZ,
      true,
    );

    expect(result.prompt).toContain('一起看');
    expect(result.prompt).not.toContain('[消息1-图片1]');
    expect(result.prompt).not.toContain('[消息1-图片2]');
    expect(result.prompt).not.toContain('/group/images/a.jpg');
    expect(result.prompt).not.toContain('/group/images/b.png');
    expect(result.attachments).toEqual([
      { type: 'image', path: '/group/images/a.jpg', label: '消息1-图片1' },
      { type: 'image', path: '/group/images/b.png', label: '消息1-图片2' },
    ]);
    expect(result.messageCount).toBe(1);
  });

  it('只剥离结构化附件对应的尾部标记，不误改用户正文中的同路径文本', () => {
    const path = '/group/images/a&b.jpg';
    const result = formatMessagesForAgent(
      [
        makeMessage({
          content: `用户原文提到 [图片: ${path}]，不要改\n[图片: ${path}]`,
          attachments: [{ type: 'image', path, source: 'feishu' }],
        }),
      ],
      TZ,
      true,
    );

    expect(result.prompt).toContain(
      '用户原文提到 [图片: /group/images/a&amp;b.jpg]，不要改',
    );
    expect(result.prompt).not.toContain('[消息1-图片1]');
    expect(result.attachments).toHaveLength(1);
  });

  it('尾部标记与附件不匹配时整体保留旧路径并不生成原生附件', () => {
    const result = formatMessagesForAgent(
      [
        makeMessage({
          content: '看图\n[图片: /group/images/other.jpg]',
          attachments: [
            { type: 'image', path: '/group/images/a.jpg', source: 'feishu' },
          ],
        }),
      ],
      TZ,
      true,
    );

    expect(result.prompt).toContain('/group/images/other.jpg');
    expect(result.attachments).toEqual([]);
  });

  it('非原生模式完全保留旧路径合同', () => {
    const result = formatMessagesForAgent(
      [
        makeMessage({
          content: '看图\n[图片: /group/images/a.jpg]',
          attachments: [
            { type: 'image', path: '/group/images/a.jpg', source: 'feishu' },
          ],
        }),
      ],
      TZ,
      false,
    );

    expect(result.prompt).toContain('/group/images/a.jpg');
    expect(result.attachments).toEqual([]);
    expect(result.messageCount).toBe(1);
  });

  it('无论尾部消息是否带图都保留真实消息数量', () => {
    const result = formatMessagesForAgent(
      [
        makeMessage({
          content: '看图\n[图片: /group/images/a.jpg]',
          attachments: [
            { type: 'image', path: '/group/images/a.jpg', source: 'feishu' },
          ],
        }),
        makeMessage({ id: 'msg-2', content: '尾部纯文字' }),
      ],
      TZ,
      true,
    );

    expect(result.messageCount).toBe(2);
    expect(result.attachments[0].label).toBe('消息1-图片1');
  });
});
