import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  FeishuUserChannel,
  FeishuUserDeps,
  messageText,
} from './feishu-user.js';
import type { EmployeeManifest } from '../meegle-employees.js';
import type { NewMessage, RegisteredGroup } from '../types.js';

const SELF = 'ou_nine';
const employee: EmployeeManifest = {
  id: 'nine',
  name: 'nine 总控',
  nodes: [],
  env: { LARK_AS: 'user' },
  dir: '/emp/nine',
};

const textMsg = (
  id: string,
  t: number,
  sender: string,
  text: string,
  mentions: Array<{ key: string; id: string; name: string }> = [],
) => ({
  message_id: id,
  msg_type: 'text',
  create_time: String(t),
  sender: { id: sender, sender_type: 'user' },
  body: { content: JSON.stringify({ text }) },
  mentions,
});

function setup(
  messages: Record<string, any[]>,
  chats: Array<{ chat_id: string; name: string; chat_mode: string }> = [
    { chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p' },
    { chat_id: 'oc_grp', name: '项目群', chat_mode: 'group' },
  ],
) {
  const state = new Map<string, string>();
  const groups: Record<string, RegisteredGroup> = {};
  const stored: NewMessage[] = [];
  const calls: string[][] = [];
  const lark = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'auth')
      return {
        identities: {
          user: { status: 'ready', openId: SELF, userName: 'nine' },
        },
      };
    if (args[1] === '+chat-list')
      return { ok: true, data: { chats: [...chats] } };
    if (args[0] === 'api') {
      const p = JSON.parse(args[args.indexOf('--params') + 1]);
      return { data: { items: messages[p.container_id] || [] } };
    }
    if (args[1] === '+get-user') return { data: { user: { name: '张三' } } };
    if (args[1] === '+messages-send')
      return { ok: true, data: { message_id: 'om_sent' } };
    return null;
  });
  let now = 1_000_000;
  const deps: FeishuUserDeps = {
    getGroup: (jid) => groups[jid],
    registerGroup: vi.fn((jid, g) => {
      groups[jid] = g;
    }),
    storeChatMetadata: vi.fn(),
    storeMessage: (m) => stored.push(m),
    getState: (k) => state.get(k),
    setState: (k, v) => state.set(k, v),
    now: () => now,
  };
  const channel = new FeishuUserChannel(employee, lark, deps);
  return {
    channel,
    lark,
    deps,
    stored,
    groups,
    calls,
    setNow: (n: number) => (now = n),
  };
}

describe('FeishuUserChannel 轮询', () => {
  it('首次发现会话只记进度点不回补；之后新消息按 ID 只入库一次', async () => {
    const msgs = {
      oc_p2p: [
        textMsg('om_old', 999_000, 'ou_zhang', '历史消息'),
        textMsg('om_1', 1_000_500, 'ou_zhang', '你好 nine'),
      ],
    };
    const { channel, lark, stored, groups, deps } = setup(msgs);
    await channel.connect();
    await channel.disconnect(); // 只手动驱动 pollOnce
    expect(await channel.pollOnce()).toBe(0); // 第一轮：记进度点
    expect(await channel.pollOnce()).toBe(1); // 第二轮：收到 om_1，历史消息被进度点挡住
    expect(await channel.pollOnce()).toBe(0); // 第三轮：同一批再返回也不重复
    expect(stored.map((m) => m.id)).toEqual(['om_1']);
    expect(stored[0]).toMatchObject({
      chat_jid: 'nine:oc_p2p',
      sender_name: '张三',
      content: '你好 nine',
    });
    expect(groups['nine:oc_p2p']).toMatchObject({
      folder: 'nine-oc_p2p',
      customCwd: '/emp/nine',
      containerConfig: { standalone: true, sharedOneCLIAgent: true },
    });
    expect(lark).toHaveBeenCalled();
  });

  it('自己发的、群里没 @ 自己的都不收；群里 @ 自己的收', async () => {
    const msgs = {
      oc_p2p: [textMsg('om_self', 1_000_600, SELF, '我的回复')],
      oc_grp: [
        textMsg('om_noat', 1_000_700, 'ou_li', '随便聊聊'),
        textMsg('om_at', 1_000_800, 'ou_li', '@_user_1 帮我看下需求', [
          { key: '@_user_1', id: SELF, name: 'nine' },
        ]),
      ],
    };
    const { channel, stored } = setup(msgs);
    await channel.connect();
    await channel.disconnect();
    await channel.pollOnce();
    await channel.pollOnce();
    expect(stored.map((m) => m.id)).toEqual(['om_at']);
    expect(stored[0].content).toBe('@nine 帮我看下需求');
  });

  it('回复以用户身份发到对应会话，进度消息不发', async () => {
    const { channel, calls } = setup({});
    await channel.connect();
    await channel.disconnect();
    expect(
      await channel.sendMessage('nine:oc_p2p', '进度', { isProgress: true }),
    ).toBeUndefined();
    expect(await channel.sendMessage('nine:oc_p2p', '好的')).toBe('om_sent');
    const send = calls.find((c) => c[1] === '+messages-send')!;
    expect(send).toEqual([
      'im',
      '+messages-send',
      '--chat-id',
      'oc_p2p',
      '--markdown',
      '好的',
      '--as',
      'user',
    ]);
    expect(channel.ownsJid('nine:oc_x')).toBe(true);
    expect(channel.ownsJid('fs:oc_x')).toBe(false);
  });

  it('用户身份未登录时拒绝启动', async () => {
    const lark = vi.fn(async () => ({
      identities: { user: { status: 'missing' } },
    }));
    const channel = new FeishuUserChannel(employee, lark, {} as FeishuUserDeps);
    await expect(channel.connect()).rejects.toThrow('未登录');
  });
});

describe('FeishuUserChannel 新会话', () => {
  it('启动后新冒出来的私聊，第一条消息不漏', async () => {
    const msgs: Record<string, any[]> = {};
    const chats = [
      { chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p' },
      { chat_id: 'oc_grp', name: '项目群', chat_mode: 'group' },
    ];
    const ctx = setup(msgs, chats);
    const { channel, stored } = ctx;
    await channel.connect();
    await channel.disconnect();
    await channel.pollOnce(); // 启动：两个已有会话记进度点
    // 一分钟后有新人私聊：消息先到，会话列表下一次刷新才出现
    ctx.setNow(1_060_000);
    msgs.oc_new = [textMsg('om_first', 1_030_000, 'ou_wang', '第一次找你')];
    chats.push({ chat_id: 'oc_new', name: '王五', chat_mode: 'p2p' });
    for (let i = 0; i < 3; i++) await channel.pollOnce(); // 第 4 轮才刷新列表
    expect(stored.map((m) => m.id)).toEqual([]);
    await channel.pollOnce();
    expect(stored.map((m) => m.id)).toEqual(['om_first']);
  });
});

describe('messageText', () => {
  it('富文本拍平，图片给占位', () => {
    expect(
      messageText({
        message_id: 'x',
        msg_type: 'post',
        create_time: '0',
        body: {
          content: JSON.stringify({
            title: '标题',
            content: [[{ tag: 'text', text: '第一行' }, { tag: 'img' }]],
          }),
        },
      }),
    ).toBe('标题\n第一行[图片]');
  });
});
