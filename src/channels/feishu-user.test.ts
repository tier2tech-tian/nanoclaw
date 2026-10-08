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
    hasMessage: (id, jid) =>
      stored.some((m) => m.id === id && m.chat_jid === jid),
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
  it('新发现的会话：回看窗口内发给 nine 的消息都补处理；重复拉取按 ID 不重复', async () => {
    const msgs = {
      oc_p2p: [
        textMsg('om_old', 999_000, 'ou_zhang', '发现会话之前就发了'),
        textMsg('om_1', 1_000_500, 'ou_zhang', '你好 nine'),
      ],
    };
    const { channel, stored, groups, setNow, deps } = setup(msgs);
    await channel.connect();
    await channel.disconnect(); // 只手动驱动 pollOnce
    setNow(1_005_000); // 轮询晚于消息发送（真实情况：有十几秒延迟）
    expect(await channel.pollOnce()).toBe(2);
    expect(await channel.pollOnce()).toBe(0); // 同一批再返回也不重复
    expect(stored.map((m) => m.id)).toEqual(['om_old', 'om_1']);
    // 按入库时间记，不早于本轮轮询时刻（message loop 才看得到），且保持先后顺序
    expect(stored.map((m) => m.timestamp)).toEqual([
      new Date(1_005_000).toISOString(),
      new Date(1_005_001).toISOString(),
    ]);
    expect(stored[1]).toMatchObject({
      chat_jid: 'nine:oc_p2p',
      sender_name: '张三',
      content: '你好 nine',
    });
    expect(groups['nine:oc_p2p']).toMatchObject({
      folder: 'nine-oc_p2p',
      customCwd: '/emp/nine',
      containerConfig: { standalone: true, sharedOneCLIAgent: true },
    });
    // 进度点丢了（比如状态被清）也不会再处理一遍：按消息 ID 去重
    (deps.setState as any)('feishu-user:nine:cursor:oc_p2p', '0');
    expect(await channel.pollOnce()).toBe(0);
  });

  it('只回看到窗口上限，更早的旧消息不翻', async () => {
    const msgs = {
      oc_p2p: [
        textMsg('om_ancient', 900_000, 'ou_zhang', '很久以前'),
        textMsg('om_recent', 995_000, 'ou_zhang', '刚才'),
      ],
    };
    const ctx = setup(msgs);
    const ch = new FeishuUserChannel(
      employee,
      ctx.lark,
      ctx.deps,
      15_000,
      10_000,
    );
    await ch.connect();
    await ch.disconnect();
    await ch.pollOnce();
    expect(ctx.stored.map((m) => m.id)).toEqual(['om_recent']);
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

describe('FeishuUserChannel 重启', () => {
  it('重启期间新冒出来的会话，从上个进程最后一次刷新列表的时间接着收', async () => {
    const msgs: Record<string, any[]> = {};
    const chats = [{ chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p' }];
    const ctx = setup(msgs, chats);
    await ctx.channel.connect();
    await ctx.channel.disconnect();
    await ctx.channel.pollOnce(); // 旧进程在 1_000_000 刷新过列表
    // 1_030_000 有人拉 nine 进新群并 @ 它；旧进程还没刷新就被重启
    chats.push({ chat_id: 'oc_new', name: '新群', chat_mode: 'group' });
    msgs.oc_new = [
      textMsg('om_at', 1_030_000, 'ou_dj', '@_user_1 在吗', [
        { key: '@_user_1', id: SELF, name: 'nine' },
      ]),
    ];
    ctx.setNow(1_060_000);
    // 新进程：同一个状态库
    const fresh = new FeishuUserChannel(employee, ctx.lark, ctx.deps);
    await fresh.connect();
    await fresh.disconnect();
    await fresh.pollOnce();
    expect(ctx.stored.map((m) => m.id)).toEqual(['om_at']);
  });
});

describe('FeishuUserChannel 群归属', () => {
  it('数字员工需求群让给员工；机器人也在的普通群，@nine 仍由 nine 回', async () => {
    const msgs = {
      oc_emp: [
        textMsg('om_e', 1_000_100, 'ou_li', '@_user_1 看下', [
          { key: '@_user_1', id: SELF, name: 'nine' },
        ]),
      ],
      oc_bot: [
        textMsg('om_b', 1_000_200, 'ou_li', '@_user_1 在吗', [
          { key: '@_user_1', id: SELF, name: 'nine' },
        ]),
      ],
    };
    const ctx = setup(msgs, [
      { chat_id: 'oc_emp', name: '需求群', chat_mode: 'group' },
      { chat_id: 'oc_bot', name: '普通群', chat_mode: 'group' },
    ]);
    ctx.groups['fs:oc_emp'] = { folder: 'emp-prd-review-1' } as RegisteredGroup;
    ctx.groups['fs:oc_bot'] = { folder: 'fs_oc_bot' } as RegisteredGroup;
    // 机器人频道已把同一条消息存进它自己的群会话：不能因此被 nine 当成已处理
    ctx.stored.push({ id: 'om_b', chat_jid: 'fs:oc_bot' } as NewMessage);
    await ctx.channel.connect();
    await ctx.channel.disconnect();
    await ctx.channel.pollOnce();
    expect(
      ctx.stored.filter((m) => m.chat_jid.startsWith('nine:')).map((m) => m.id),
    ).toEqual(['om_b']);
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
