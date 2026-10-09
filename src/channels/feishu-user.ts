/**
 * 飞书真人账号频道：让一个普通飞书账号（如总控 nine）当数字员工的收发入口。
 *
 * 飞书不会把"普通账号收到的消息"推给应用，所以这里用该账号的用户身份（lark-cli --as user）轮询：
 * 定时列出它的私聊/群 → 拉每个会话里比进度点新的消息 → 存库交给 message loop → 回复也以该账号身份发出。
 *
 * 一个飞书会话（私聊或群）= 一个 NanoClaw 会话：jid `<员工>:<chat_id>`，folder `<员工>-<chat_id>`。
 * 去重三层：消息按 ID + 会话去重 + 每会话进度点只往后拉 + 一轮拉完才开始下一轮。
 * 回复发失败进待发件箱（router_state），每轮轮询先重投，超过 OUTBOX_TTL_MS 才放弃。
 */
import { execFile } from 'child_process';
import path from 'path';

import { logger } from '../logger.js';
import { isEmployeeFolder } from '../meegle-employees.js';
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
  /** 这条消息在该会话里是否已入库（按飞书消息 ID + 会话去重；同一条可能也被机器人频道存在它的群会话里） */
  hasMessage: (id: string, jid: string) => boolean;
  getState: (key: string) => string | undefined;
  setState: (key: string, value: string) => void;
  /** 库里最新一条消息的时间（毫秒）；入库时间必须晚于它，message loop 才看得到 */
  latestMessageTime?: () => number;
  /** 被监听的群（如用户反馈群）：nine 不在群里说话，新话题交给员工分析 */
  watches?: WatchedChat[];
  /** 把一个新话题派给员工；返回 false 表示没派出去，下一轮重试 */
  dispatchTopic?: (watch: WatchedChat, topic: WatchTopic) => Promise<boolean>;
  now?: () => number;
}

export interface WatchedChat {
  chatId: string;
  /** 负责分析的员工 id */
  employee: string;
  /** 巡检间隔（毫秒） */
  intervalMs: number;
}

export interface WatchTopic {
  chatId: string;
  /** 话题 ID（omt_xxx），一个话题 = 一个员工会话 */
  threadId: string;
  messageId: string;
  createTime: number;
  senderId: string;
  senderName: string;
  text: string;
}

/** 解析 FEISHU_USER_WATCH：`<chat_id>:<员工>:<间隔毫秒>`，多个用逗号分隔 */
export function parseWatches(raw: string | undefined): WatchedChat[] {
  return (raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [chatId, employee, ms] = x.split(':');
      return { chatId, employee, intervalMs: Number(ms) || 120_000 };
    })
    .filter((w) => w.chatId && w.employee);
}

interface OutboxItem {
  jid: string;
  text: string;
  at: number;
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
  /** 话题群：根消息没有 parent_id，回复有 */
  parent_id?: string;
  thread_id?: string;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: Array<{ key: string; id: string; name: string }>;
}

/** 每 N 轮刷新一次会话列表（新私聊/新群） */
const CHAT_REFRESH_EVERY = 4;
/** 待发件箱里的回复最多重投多久 */
const OUTBOX_TTL_MS = 24 * 3600_000;

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
      // 每条都是发给它的请求：排队期间攒超了也不丢，合成一条（见 message-backlog.ts）
      foldBacklog: true,
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
  private flushing: Promise<void> | null = null;
  private lastWatchPoll = new Map<string, number>();

  constructor(
    private employee: EmployeeManifest,
    private lark: LarkRunner,
    private deps: FeishuUserDeps,
    private pollMs = 15_000,
    /** 新发现的会话往回看多久：发给 nine、还没处理过的消息都补处理，只防翻太久的旧账 */
    private lookbackMs = 24 * 3600_000,
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
    return (
      jid.startsWith(this.prefix) &&
      !this.watchOf(jid.slice(this.prefix.length))
    );
  }

  private watchOf(chatId: string): WatchedChat | undefined {
    return this.deps.watches?.find((w) => w.chatId === chatId);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined> {
    if (options?.isProgress) return undefined;
    if (this.watchOf(jid.slice(this.prefix.length)))
      throw new Error('[feishu-user] 被监听的群不允许以 nine 身份发言');
    // 同会话还有没发出去的，先补发，保证先后顺序
    if (this.outbox().some((o) => o.jid === jid)) await this.flushOutbox();
    if (!this.outbox().some((o) => o.jid === jid)) {
      const id = await this.send(jid, text);
      if (id) return id;
    }
    // 发不出去（飞书 5xx、身份失效、超时）：进待发件箱，下一轮轮询重投，不丢
    this.saveOutbox([...this.outbox(), { jid, text, at: this.now() }]);
    logger.error({ jid }, '[feishu-user] 回复未发出，已进待发件箱等重投');
    return undefined;
  }

  private async send(jid: string, text: string): Promise<string | undefined> {
    const res = await this.lark([
      'im',
      '+messages-send',
      '--chat-id',
      jid.slice(this.prefix.length),
      '--markdown',
      text,
      '--as',
      'user',
    ]);
    if (!res?.ok) {
      logger.warn(
        { jid, error: res?.error?.message },
        '[feishu-user] 以用户身份发消息失败',
      );
      return undefined;
    }
    return res.data?.message_id || 'sent';
  }

  private get outboxKey(): string {
    return `feishu-user:${this.employee.id}:outbox`;
  }

  private outbox(): OutboxItem[] {
    try {
      return JSON.parse(this.deps.getState(this.outboxKey) || '[]');
    } catch {
      return [];
    }
  }

  private saveOutbox(items: OutboxItem[]): void {
    this.deps.setState(this.outboxKey, JSON.stringify(items));
  }

  /** 按顺序重投；某会话一条失败，该会话后面的都不发（保序），其他会话照发。同一时刻只跑一份 */
  flushOutbox(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const snapshot = this.outbox();
    if (!snapshot.length) return;
    const left: OutboxItem[] = [];
    const blocked = new Set<string>();
    for (const item of snapshot) {
      if (this.now() - item.at > OUTBOX_TTL_MS) {
        logger.error(
          { jid: item.jid, text: item.text.slice(0, 100) },
          '[feishu-user] 回复重投超过 24 小时仍失败，放弃',
        );
        continue;
      }
      if (!blocked.has(item.jid) && (await this.send(item.jid, item.text)))
        continue;
      blocked.add(item.jid);
      left.push(item);
    }
    // 重投期间别处只会往箱尾追加，保留这些新进箱的
    this.saveOutbox([...left, ...this.outbox().slice(snapshot.length)]);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
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
    await this.flushOutbox();
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
      // 被监听的群只做巡检，@nine 也不在群里回
      if (this.watchOf(chat.chat_id)) continue;
      // 数字员工的需求群归员工处理，nine 只是成员、不插话；
      // 其他群即使机器人也在（会被机器人频道自动注册），@nine 的仍由 nine 回
      const botGroup = this.deps.getGroup(`fs:${chat.chat_id}`);
      if (botGroup && isEmployeeFolder(botGroup.folder)) continue;
      stored += await this.pollChat(chat);
    }
    for (const w of this.deps.watches || []) {
      const last = this.lastWatchPoll.get(w.chatId) ?? 0;
      if (this.now() - last < w.intervalMs) continue;
      this.lastWatchPoll.set(w.chatId, this.now());
      await this.pollWatch(w);
    }
    return stored;
  }

  /**
   * 巡检被监听的群：只看进度点之后的新消息（读过的不再读），
   * 新话题（根消息、真人发的）派给员工；派成功才记"已派"，失败停在这条下一轮重试。
   * 第一次巡检从当前时刻开始，不回补历史话题。
   */
  async pollWatch(w: WatchedChat): Promise<number> {
    const now = this.now();
    const key = `feishu-user:${this.employee.id}:watch:${w.chatId}:cursor`;
    const saved = this.deps.getState(key);
    if (!saved) {
      this.deps.setState(key, String(now));
      return 0;
    }
    const cursor = Number(saved);
    const items = await this.fetchSince(w.chatId, cursor);
    let progress = cursor;
    let dispatched = 0;
    for (const m of items) {
      const t = Number(m.create_time);
      if (!(t > cursor)) continue;
      const isTopic =
        !m.parent_id &&
        !m.deleted &&
        m.sender?.sender_type === 'user' &&
        m.sender?.id !== this.selfOpenId &&
        !!m.thread_id;
      if (isTopic) {
        const seenKey = `feishu-user:${this.employee.id}:watch:${w.chatId}:topic:${m.thread_id}`;
        if (!this.deps.getState(seenKey)) {
          const topic: WatchTopic = {
            chatId: w.chatId,
            threadId: m.thread_id!,
            messageId: m.message_id,
            createTime: t,
            senderId: m.sender?.id || '',
            senderName: await this.senderName(m.sender?.id || ''),
            text: messageText(m),
          };
          const ok = (await this.deps.dispatchTopic?.(w, topic)) ?? false;
          if (!ok) break; // 停在这条之前，下一轮从这里重来
          this.deps.setState(seenKey, String(now));
          dispatched++;
        }
      }
      progress = Math.max(progress, t);
    }
    if (progress > cursor) this.deps.setState(key, String(progress));
    return dispatched;
  }

  private async fetchSince(
    chatId: string,
    cursor: number,
  ): Promise<LarkMessage[]> {
    const items: LarkMessage[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const res = await this.lark([
        'api',
        'GET',
        '/open-apis/im/v1/messages',
        '--params',
        JSON.stringify({
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(Math.floor(cursor / 1000)),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
        '--as',
        'user',
      ]);
      items.push(...(res?.data?.items || []));
      if (!res?.data?.has_more || !res.data.page_token) break;
      pageToken = res.data.page_token;
    }
    return items;
  }

  private cursorKey(chatId: string): string {
    return `feishu-user:${this.employee.id}:cursor:${chatId}`;
  }

  private async pollChat(chat: LarkChat): Promise<number> {
    const now = this.now();
    const key = this.cursorKey(chat.chat_id);
    const saved = this.deps.getState(key);
    // 规则：发给 nine、还没处理过的消息都要处理。新发现的会话（含新人第一次私聊、刚被拉进群、
    // 重启空档）往回看 lookbackMs，靠消息 ID 去重，不会回两遍
    const cursor = saved ? Number(saved) : now - this.lookbackMs;
    const items = await this.fetchSince(chat.chat_id, cursor);
    const isGroup = chat.chat_mode !== 'p2p';
    const jid = `${this.prefix}${chat.chat_id}`;
    let maxTime = cursor;
    const fresh: NewMessage[] = [];
    for (const m of items) {
      const t = Number(m.create_time);
      if (!(t > cursor)) continue; // start_time 按秒取整会带回旧消息
      maxTime = Math.max(maxTime, t);
      if (m.deleted || m.sender?.sender_type !== 'user') continue;
      if (m.sender?.id === this.selfOpenId) continue; // 自己发的不回
      if (isGroup && !(m.mentions || []).some((x) => x.id === this.selfOpenId))
        continue; // 群里只接 @ 自己的
      if (this.deps.hasMessage(m.message_id, jid)) continue; // 已处理过
      const text = messageText(m);
      if (!text) continue;
      fresh.push({
        id: m.message_id,
        chat_jid: jid,
        sender: m.sender?.id || '',
        sender_name: await this.senderName(m.sender?.id || ''),
        content: text,
        timestamp: new Date(t).toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
    }
    // 以下全同步，中间不 await：入库时间在这里现取，保证晚于库里任何消息，
    // message loop 一定看得到（等网络期间别的频道可能已把"已看过时间点"推到更后面）
    const batch = fresh;
    if (batch.length) {
      const base = Math.max(
        this.now(),
        (this.deps.latestMessageTime?.() ?? 0) + 1,
      );
      batch.forEach((msg, i) => {
        msg.timestamp = new Date(base + i).toISOString();
      });
      const ts = batch[0].timestamp;
      // 每次都按当前配置重建（老会话补上 foldBacklog 等新配置），added_at 保留
      this.deps.registerGroup(
        jid,
        buildUserChatGroup(
          this.employee,
          chat.chat_id,
          chat.name || chat.chat_id,
          this.deps.getGroup(jid)?.added_at ?? ts,
        ),
      );
      this.deps.storeChatMetadata(jid, ts, chat.name || chat.chat_id, isGroup);
      for (const msg of batch) this.deps.storeMessage(msg);
    }
    const stored = batch.length;
    if (maxTime > cursor || !saved)
      this.deps.setState(key, String(Math.max(maxTime, cursor)));
    // 不主动 enqueue：交给 message loop 统一发现。主动 enqueue 会和 loop 各送一次，
    // agent 进程活着时 loop 会把同一条再 pipe 进去，导致回复两遍（2026-10-08 实测）
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
