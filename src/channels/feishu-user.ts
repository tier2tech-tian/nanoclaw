/**
 * 飞书真人账号频道：让一个普通飞书账号（如总控 nine）当数字员工的收发入口。
 *
 * 飞书不会把"普通账号收到的消息"推给应用，所以这里用该账号的用户身份（lark-cli --as user）轮询：
 * 定时列出它的私聊/群 → 拉每个会话里比进度点新的消息 → 存库交给 message loop → 回复也以该账号身份发出。
 *
 * 一个飞书会话（私聊或群）= 一个 NanoClaw 会话：jid `<员工>:<chat_id>`，folder `<员工>-<chat_id>`。
 * 去重三层：消息按 ID 存（重复覆盖）+ 每会话进度点只往后拉 + 一轮拉完才开始下一轮。
 */
import { execFile } from 'child_process';
import path from 'path';

import { logger } from '../logger.js';
import type { EmployeeManifest } from '../meegle-employees.js';
import type {
  Channel,
  NewMessage,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

/** 调 lark-cli 并返回解析后的 JSON；测试里替换成假实现 */
export type LarkRunner = (args: string[]) => Promise<any>;

export interface FeishuUserDeps {
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  storeChatMetadata: (
    jid: string,
    timestamp: string,
    name: string,
    isGroup: boolean,
  ) => void;
  storeMessage: (msg: NewMessage) => void;
  enqueueMessageCheck: (jid: string) => void;
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
  now?: () => number;
}

interface LarkChat {
  chat_id: string;
  name?: string;
  /** lark-cli +chat-list 实际返回 chat_mode（p2p / group） */
  chat_mode?: string;
}

interface LarkMessage {
  message_id: string;
  msg_type: string;
  create_time: string;
  deleted?: boolean;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: Array<{ key: string; id: string; name: string }>;
}

/** 每 N 轮刷新一次会话列表（新私聊/新群） */
const CHAT_REFRESH_EVERY = 4;

/** 把飞书消息体转成给 agent 看的文本；@ 占位符换成名字 */
export function messageText(m: LarkMessage): string {
  let content: any = {};
  try {
    content = JSON.parse(m.body?.content || '{}');
  } catch {
    return '';
  }
  let text = '';
  if (m.msg_type === 'text') {
    text = content.text || '';
  } else if (m.msg_type === 'post') {
    const post = content.content ? content : Object.values(content)[0] || {};
    const lines: string[] = [];
    if (post.title) lines.push(post.title);
    for (const para of post.content || []) {
      lines.push(
        para
          .map((el: any) =>
            el.tag === 'text' || el.tag === 'a'
              ? el.text
              : el.tag === 'at'
                ? `@${el.user_name || ''}`
                : el.tag === 'img'
                  ? '[图片]'
                  : '',
          )
          .join(''),
      );
    }
    text = lines.join('\n');
  } else if (m.msg_type === 'image') {
    text = '[图片]';
  } else if (m.msg_type === 'file') {
    text = `[文件] ${content.file_name || ''}`;
  } else {
    text = `[${m.msg_type} 消息]`;
  }
  for (const mention of m.mentions || []) {
    text = text.split(mention.key).join(`@${mention.name}`);
  }
  return text.trim();
}

/** "员工 × 飞书会话"的会话配置：独立模式 + 共享账号组，cwd 指向员工目录 */
export function buildUserChatGroup(
  employee: EmployeeManifest,
  chatId: string,
  name: string,
  addedAt: string,
): RegisteredGroup {
  return {
    name: `${employee.name} · ${name}`,
    folder: `${employee.id}-${chatId}`,
    trigger: `@${employee.id}`,
    added_at: addedAt,
    requiresTrigger: false,
    customCwd: employee.dir,
    containerConfig: {
      standalone: true,
      sharedOneCLIAgent: true,
      quietProgress: true,
      // 聊天会有追问，保留 10 分钟上下文进程；之后按 session 续接
      idleTimeout: 600_000,
      env: { ...employee.env, PATH: path.join(employee.dir, 'bin') },
    },
  };
}

export class FeishuUserChannel implements Channel {
  name = 'feishu-user';
  private selfOpenId = '';
  private chats: LarkChat[] = [];
  private round = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private senderNames = new Map<string, string>();

  constructor(
    private employee: EmployeeManifest,
    private lark: LarkRunner,
    private deps: FeishuUserDeps,
    private pollMs = 15_000,
  ) {}

  private get prefix(): string {
    return `${this.employee.id}:`;
  }

  async connect(): Promise<void> {
    const status = await this.lark(['auth', 'status']);
    const user = status?.identities?.user;
    if (!user?.openId || user.status !== 'ready') {
      throw new Error(
        `[feishu-user] ${this.employee.id} 的用户身份未登录或已失效，频道不启动`,
      );
    }
    this.selfOpenId = user.openId;
    logger.info(
      { employee: this.employee.id, user: user.userName },
      '[feishu-user] 真人账号频道已启动',
    );
    this.schedule(0);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  isConnected(): boolean {
    return !this.stopped && !!this.selfOpenId;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.prefix);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined> {
    if (options?.isProgress) return undefined;
    const chatId = jid.slice(this.prefix.length);
    const res = await this.lark([
      'im',
      '+messages-send',
      '--chat-id',
      chatId,
      '--markdown',
      text,
      '--as',
      'user',
    ]);
    if (!res?.ok) {
      logger.error(
        { jid, error: res?.error?.message },
        '[feishu-user] 以用户身份发消息失败',
      );
      return undefined;
    }
    return res.data?.message_id;
  }

  /** 一轮拉完再排下一轮，不会两轮同时跑 */
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.warn({ err: String(err) }, '[feishu-user] 本轮拉取失败');
      }
      this.schedule(this.pollMs);
    }, delay);
  }

  async pollOnce(): Promise<number> {
    if (this.round % CHAT_REFRESH_EVERY === 0 || this.chats.length === 0) {
      const res = await this.lark([
        'im',
        '+chat-list',
        '--types',
        'p2p,group',
        '--page-all',
        '--as',
        'user',
      ]);
      if (res?.ok) this.chats = res.data?.chats || [];
    }
    this.round++;
    let stored = 0;
    for (const chat of this.chats) {
      stored += await this.pollChat(chat);
    }
    return stored;
  }

  private cursorKey(chatId: string): string {
    return `feishu-user:${this.employee.id}:cursor:${chatId}`;
  }

  private async pollChat(chat: LarkChat): Promise<number> {
    const now = (this.deps.now ?? Date.now)();
    const key = this.cursorKey(chat.chat_id);
    const saved = this.deps.getState(key);
    if (!saved) {
      // 新发现的会话不回补历史，从此刻开始收
      this.deps.setState(key, String(now));
      return 0;
    }
    const cursor = Number(saved);
    const res = await this.lark([
      'api',
      'GET',
      '/open-apis/im/v1/messages',
      '--params',
      JSON.stringify({
        container_id_type: 'chat',
        container_id: chat.chat_id,
        start_time: String(Math.floor(cursor / 1000)),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
      }),
      '--as',
      'user',
    ]);
    const items: LarkMessage[] = res?.data?.items || [];
    const isGroup = chat.chat_mode !== 'p2p';
    const jid = `${this.prefix}${chat.chat_id}`;
    let maxTime = cursor;
    let stored = 0;
    for (const m of items) {
      const t = Number(m.create_time);
      if (!(t > cursor)) continue; // start_time 按秒取整会带回旧消息
      maxTime = Math.max(maxTime, t);
      if (m.deleted || m.sender?.sender_type !== 'user') continue;
      if (m.sender?.id === this.selfOpenId) continue; // 自己发的不回
      if (isGroup && !(m.mentions || []).some((x) => x.id === this.selfOpenId))
        continue; // 群里只接 @ 自己的
      const text = messageText(m);
      if (!text) continue;
      const ts = new Date(t).toISOString();
      if (!this.deps.getGroup(jid)) {
        this.deps.registerGroup(
          jid,
          buildUserChatGroup(
            this.employee,
            chat.chat_id,
            chat.name || chat.chat_id,
            ts,
          ),
        );
      }
      this.deps.storeChatMetadata(jid, ts, chat.name || chat.chat_id, isGroup);
      this.deps.storeMessage({
        id: m.message_id,
        chat_jid: jid,
        sender: m.sender?.id || '',
        sender_name: await this.senderName(m.sender?.id || ''),
        content: text,
        timestamp: ts,
        is_from_me: false,
        is_bot_message: false,
      });
      stored++;
    }
    if (maxTime > cursor) this.deps.setState(key, String(maxTime));
    if (stored > 0) this.deps.enqueueMessageCheck(jid);
    return stored;
  }

  private async senderName(openId: string): Promise<string> {
    if (!openId) return '';
    const cached = this.senderNames.get(openId);
    if (cached) return cached;
    const res = await this.lark([
      'contact',
      '+get-user',
      '--user-id',
      openId,
      '--as',
      'user',
    ]).catch(() => null);
    const name: string = res?.data?.user?.name || res?.data?.name || openId;
    this.senderNames.set(openId, name);
    return name;
  }
}

/** 真实 lark-cli 调用：清掉代理变量，固定 profile，解析 stdout 里的 JSON */
export function createLarkRunner(profile: string): LarkRunner {
  return (args) =>
    new Promise((resolve) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !k.toLowerCase().includes('proxy'),
        ),
      );
      env.LARK_CLI_NO_PROXY = '1';
      execFile(
        'lark-cli',
        [...args, '--profile', profile],
        { env, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        (_err, stdout) => {
          const raw = String(stdout || '');
          const i = raw.indexOf('{');
          try {
            resolve(i >= 0 ? JSON.parse(raw.slice(i)) : null);
          } catch {
            resolve(null);
          }
        },
      );
    });
}
