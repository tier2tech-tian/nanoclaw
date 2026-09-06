import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mocks ----

const mockGetAllChats = vi.fn(() => [] as any[]);

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TIMEZONE: 'Asia/Shanghai',
  ASSISTANT_NAME: 'test-bot',
  MAX_MESSAGES_PER_PROMPT: 20,
  IDLE_TIMEOUT: 1800000,
  IPC_POLL_INTERVAL: 1000,
  DEFAULT_TRIGGER: '@test-bot',
  TRIGGER_PATTERN: /@test-bot(?=[\s\p{P}]|$)/iu,
  getTriggerPattern: (trigger?: string) =>
    new RegExp(
      `${(trigger || '@test-bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s\\p{P}]|$)`,
      'iu',
    ),
  buildTriggerPattern: (trigger: string) =>
    new RegExp(
      `${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s\\p{P}]|$)`,
      'iu',
    ),
  ONECLI_URL: 'http://localhost:10254',
  CHAT_INDEX_ENABLED: false,
  envConfig: {},
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getAllChats: () => mockGetAllChats(),
  getMessagesSince: vi.fn(() => []),
  upsertChat: vi.fn(),
  getRotateEnabled: vi.fn(() => false),
  getRotateIndex: vi.fn(() => 0),
  getLastRotateAt: vi.fn(() => null),
  setRotateIndex: vi.fn(),
  setLastRotateAt: vi.fn(),
  getChatName: vi.fn(),
  getAllTasks: vi.fn(() => []),
  setSession: vi.fn(),
  getLastBotMessageTimestamp: vi.fn(() => null),
  getRecentUserMessages: vi.fn(() => []),
  getActiveDelegationByGroup: vi.fn(() => null),
  setRouterState: vi.fn(),
  getRouterState: vi.fn(() => null),
}));

vi.mock('./container-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: vi.fn(),
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    getSecretCount: () => 1,
  };
});
vi.mock('./memory/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memory/index.js')>();
  return { ...actual, isMemoryEnabled: () => false };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    getContainerConfig = vi
      .fn()
      .mockResolvedValue({ env: {}, caCertificate: '' });
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ id: 'test', created: false });
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

import {
  parseModelPrefix,
  getAvailableGroups,
  _setRegisteredGroups,
  decideThinkingOnlyAction,
  shouldTriggerAutoFollowupSummary,
  buildAutoFollowupSummaryPrompt,
  runAgent,
  processGroupMessages,
} from './index.js';
import { buildTriggerPattern } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { setSession, getMessagesSince, setRouterState } from './db.js';
import fs from 'fs';
import path from 'path';
import { dispatch } from './commands/registry.js';

describe('codex-as 宿主真实运行入口', () => {
  it('真实错误回调发送失败后推进游标，下一次只补通知不重跑', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const folder = `as-notice-${Date.now()}`;
    const root = path.join('/tmp/nanoclaw-test-data/ipc', folder);
    const keys = ['mkdirSync', 'writeFileSync', 'readFileSync', 'readdirSync', 'existsSync'] as const;
    const saved = keys.map(key => vi.mocked(fs[key]).getMockImplementation());
    for (const key of keys) (vi.mocked(fs[key]) as any).mockImplementation(realFs[key]);
    try {
      const jid = folder;
      const group = { name: 'as', folder, trigger: '@as', added_at: '', isMain: true, containerConfig: { cliMode: 'codex-as' as const } };
      _setRegisteredGroups({ [jid]: group });
      const message: any = { id: 'msg', chat_jid: jid, content: '测试原任务', sender: 'sender', sender_name: '测试', timestamp: '2026-09-06T14:00:00.000Z' };
      vi.mocked(getMessagesSince).mockReturnValueOnce([message]);
      vi.mocked(setRouterState).mockClear();
      vi.mocked(runContainerAgent).mockClear();
      vi.mocked(runContainerAgent).mockImplementationOnce(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: 'error', result: 'fetch failed', error: 'ETIMEDOUT' });
        return { status: 'error', result: null };
      });
      const sendMessage = vi.fn().mockRejectedValueOnce(new Error('渠道断线')).mockResolvedValue('notice-id');
      const channel: any = { name: 'test', ownsJid: () => true, sendMessage };
      expect(await processGroupMessages(jid, [channel])).toBe(true);
      expect(runContainerAgent).toHaveBeenCalledTimes(1);
      expect(setRouterState).toHaveBeenCalledWith('last_agent_timestamp', expect.stringContaining(message.timestamp));
      expect(realFs.readdirSync(path.join(root, 'codex-as-notices'))).toHaveLength(1);
      vi.mocked(getMessagesSince).mockReturnValueOnce([]);
      expect(await processGroupMessages(jid, [channel])).toBe(true);
      expect(runContainerAgent).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenLastCalledWith(jid, 'fetch failed', { isCommandReply: true });
      expect(realFs.readdirSync(path.join(root, 'codex-as-notices'))).toHaveLength(0);
    } finally {
      realFs.rmSync(root, { recursive: true, force: true });
      keys.forEach((key, i) => (vi.mocked(fs[key]) as any).mockImplementation(saved[i]));
      _setRegisteredGroups({});
    }
  });
  it('切走再切回后旧注册、输出与最终返回不能写回会话', async () => {
    const group = {
      name: 'as',
      folder: 'as-host',
      trigger: '@as',
      added_at: '',
      containerConfig: { cliMode: 'codex-as' as const },
    };
    let release!: (value: any) => void;
    let register!: (...args: any[]) => void;
    let output!: (value: any) => Promise<void>;
    vi.mocked(setSession).mockClear();
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_g, _i, onProcess, onOutput) => {
        register = onProcess;
        output = onOutput!;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    );
    const received = vi.fn(async () => {});
    const running = runAgent(group, '旧任务', 'as-host-jid', received);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const deps: any = {
      chatJid: 'as-host-jid',
      group,
      sessions: {},
      queue: { killGroup: vi.fn() },
      channels: [{ ownsJid: () => true, sendMessage: vi.fn(async () => {}) }],
      registeredGroups: {},
      setRegisteredGroup: vi.fn(),
      deleteSession: vi.fn(),
      msg: { timestamp: '' },
    };
    await dispatch('/mode codex', deps);
    await dispatch('/mode codex-as', deps);
    const process = { kill: vi.fn() };
    register(process, 'old');
    await output({
      status: 'success',
      result: '旧结果',
      newSessionId: 'old-session',
    });
    release({
      status: 'error',
      error: 'ETIMEDOUT',
      newSessionId: 'old-session',
    });
    expect((await running).status).toBe('success');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(received).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
  });

  it('codex-as 瞬时错误和通知抛错均返回不可重试，不能重新 spawn', async () => {
    const group = {
      name: 'as',
      folder: 'as-error',
      trigger: '@as',
      added_at: '',
      containerConfig: { cliMode: 'codex-as' as const },
    };
    vi.mocked(runContainerAgent).mockClear();
    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'fetch failed',
    });
    expect(await runAgent(group, '原任务', 'as-error')).toMatchObject({
      status: 'error',
      noRetry: true,
    });
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    vi.mocked(runContainerAgent).mockRejectedValueOnce(
      new Error('通知发送失败'),
    );
    expect(await runAgent(group, '原任务', 'as-error')).toMatchObject({
      status: 'error',
      noRetry: true,
    });
    expect(runContainerAgent).toHaveBeenCalledTimes(2);
  });
});

// ---- parseModelPrefix ----

describe('parseModelPrefix', () => {
  it('"!! msg" → Sonnet adaptive', () => {
    const r = parseModelPrefix('!! hello world');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-sonnet-4-6',
      thinking: 'adaptive',
    });
    expect(r!.cleanedText).toBe('hello world');
  });

  it('"! msg" → Sonnet disabled', () => {
    const r = parseModelPrefix('! quick answer');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-sonnet-4-6',
      thinking: 'disabled',
    });
    expect(r!.cleanedText).toBe('quick answer');
  });

  it('"+ msg" → Opus adaptive', () => {
    const r = parseModelPrefix('+ deep thought');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-opus-4-6',
      thinking: 'adaptive',
    });
    expect(r!.cleanedText).toBe('deep thought');
  });

  it('"~ msg" → disabled（无 model）', () => {
    const r = parseModelPrefix('~ no thinking');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({ thinking: 'disabled' });
    expect(r!.cleanedText).toBe('no thinking');
  });

  it('全角 "！！ msg" → 同 "!!"', () => {
    const r = parseModelPrefix('！！ 深度思考');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.override.thinking).toBe('adaptive');
    expect(r!.cleanedText).toBe('深度思考');
  });

  it('全角 "！ msg" → 同 "!"', () => {
    const r = parseModelPrefix('！ 快速');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.override.thinking).toBe('disabled');
    expect(r!.cleanedText).toBe('快速');
  });

  it('混合 "!！ msg" → 同 "!!"', () => {
    const r = parseModelPrefix('!！ mixed');
    expect(r).not.toBeNull();
    expect(r!.override.thinking).toBe('adaptive');
  });

  it('无前缀 → null', () => {
    expect(parseModelPrefix('普通消息')).toBeNull();
  });

  it('空字符串 → null', () => {
    expect(parseModelPrefix('')).toBeNull();
  });

  it('只有前缀没有内容 "! " → null（trim 后无空格）', () => {
    // "! " trim 后变成 "!"，不含空格，不触发
    expect(parseModelPrefix('! ')).toBeNull();
  });

  it('"! a" 前缀+单字符 → 正常触发', () => {
    const r = parseModelPrefix('! a');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.cleanedText).toBe('a');
  });

  it('前缀后无空格 "!msg" → null（不触发）', () => {
    expect(parseModelPrefix('!msg')).toBeNull();
  });

  it('"!!msg" 无空格 → null', () => {
    expect(parseModelPrefix('!!msg')).toBeNull();
  });

  it('"+" 无空格 → null', () => {
    expect(parseModelPrefix('+msg')).toBeNull();
  });

  it('"~" 无空格 → null', () => {
    expect(parseModelPrefix('~msg')).toBeNull();
  });

  it('前导空白被 trim 后仍匹配', () => {
    const r = parseModelPrefix('  !! spaced');
    expect(r).not.toBeNull();
    expect(r!.override.thinking).toBe('adaptive');
  });
});

// ---- getAvailableGroups ----

describe('getAvailableGroups', () => {
  beforeEach(() => {
    mockGetAllChats.mockReturnValue([]);
    _setRegisteredGroups({});
  });

  it('过滤 __group_sync__ 键', () => {
    mockGetAllChats.mockReturnValue([
      {
        jid: '__group_sync__',
        name: 'sync',
        last_message_time: '2026-01-01',
        is_group: true,
      },
      {
        jid: 'fs:oc_real',
        name: 'real',
        last_message_time: '2026-01-01',
        is_group: true,
      },
    ]);
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('fs:oc_real');
  });

  it('只返回 is_group 为 true 的', () => {
    mockGetAllChats.mockReturnValue([
      {
        jid: 'fs:oc_g1',
        name: 'group',
        last_message_time: '2026-01-01',
        is_group: true,
      },
      {
        jid: 'fs:ou_priv',
        name: 'private',
        last_message_time: '2026-01-01',
        is_group: false,
      },
    ]);
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('fs:oc_g1');
  });

  it('空输入返回空数组', () => {
    mockGetAllChats.mockReturnValue([]);
    expect(getAvailableGroups()).toEqual([]);
  });

  it('isRegistered 正确标注', () => {
    mockGetAllChats.mockReturnValue([
      {
        jid: 'fs:oc_reg',
        name: '注册群',
        last_message_time: '2026-01-01',
        is_group: true,
      },
      {
        jid: 'fs:oc_unreg',
        name: '未注册',
        last_message_time: '2026-01-01',
        is_group: true,
      },
    ]);
    _setRegisteredGroups({
      'fs:oc_reg': { name: '注册群', folder: 'reg', jid: 'fs:oc_reg' } as any,
    });
    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'fs:oc_reg');
    const unreg = groups.find((g) => g.jid === 'fs:oc_unreg');
    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });
});

// ---- auto follow-up summary ----

describe('shouldTriggerAutoFollowupSummary', () => {
  const longText = '这是一段足够长的回复。'.repeat(20);

  it('开启后支持 SDK、CLI interactive 和 Codex', () => {
    for (const cliMode of ['sdk', 'interactive', 'codex'] as const) {
      expect(
        shouldTriggerAutoFollowupSummary({
          enabled: true,
          cliMode,
          text: longText,
          isAutoFollowupTurn: false,
          hadError: false,
        }),
      ).toBe(true);
    }
  });

  it('不支持 print 和 gemini', () => {
    for (const cliMode of ['print', 'gemini'] as const) {
      expect(
        shouldTriggerAutoFollowupSummary({
          enabled: true,
          cliMode,
          text: longText,
          isAutoFollowupTurn: false,
          hadError: false,
        }),
      ).toBe(false);
    }
  });

  it('关闭配置、自动总结回合、错误回合、短回复都不触发', () => {
    expect(
      shouldTriggerAutoFollowupSummary({
        enabled: false,
        cliMode: 'sdk',
        text: longText,
        isAutoFollowupTurn: false,
        hadError: false,
      }),
    ).toBe(false);
    expect(
      shouldTriggerAutoFollowupSummary({
        enabled: true,
        cliMode: 'sdk',
        text: longText,
        isAutoFollowupTurn: true,
        hadError: false,
      }),
    ).toBe(false);
    expect(
      shouldTriggerAutoFollowupSummary({
        enabled: true,
        cliMode: 'sdk',
        text: longText,
        isAutoFollowupTurn: false,
        hadError: true,
      }),
    ).toBe(false);
    expect(
      shouldTriggerAutoFollowupSummary({
        enabled: true,
        cliMode: 'sdk',
        text: '太短了',
        isAutoFollowupTurn: false,
        hadError: false,
      }),
    ).toBe(false);
  });
});

describe('buildAutoFollowupSummaryPrompt', () => {
  it('生成带防递归标记和工具约束的总结 prompt', () => {
    const prompt =
      buildAutoFollowupSummaryPrompt('这是已经发送给用户的完整回复');
    expect(prompt).toContain('[AUTO_FOLLOWUP_SUMMARY]');
    expect(prompt).toContain('不要调用工具');
    expect(prompt).toContain('第一句话必须是结论');
    expect(prompt).toContain('这是已经发送给用户的完整回复');
  });

  it('长回复会截断，避免把下一轮 prompt 撑爆', () => {
    const prompt = buildAutoFollowupSummaryPrompt(`${'a'.repeat(7000)}尾巴`);
    expect(prompt).toContain('a'.repeat(100));
    expect(prompt).not.toContain('尾巴');
    expect(prompt.length).toBeLessThan(6500);
  });
});

// ---- buildTriggerPattern ----
// 注意：这里测的是 mock 中的 buildTriggerPattern（与真实 config.ts 实现逻辑一致）。
// 目的是验证正则模式本身的行为，不是对 config 模块的集成测试。

describe('buildTriggerPattern', () => {
  it('正则 trigger 匹配成功', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('@大狗 你好')).toBe(true);
  });

  it('结尾 @大狗 也匹配', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('你好 @大狗')).toBe(true);
  });

  it('后面无空格/标点也匹配（行尾）', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('@大狗')).toBe(true);
  });
});

// ---- decideThinkingOnlyAction ----

describe('decideThinkingOnlyAction', () => {
  const base = {
    hasText: false,
    textSentToUser: false,
    outputTokens: 100,
    retryCount: 0,
    maxRetries: 1,
  };

  it('thinking-only 且未重试过 → retry', () => {
    expect(decideThinkingOnlyAction(base)).toBe('retry');
  });

  it('thinking-only 且已达上限 → giveup（防死循环）', () => {
    expect(decideThinkingOnlyAction({ ...base, retryCount: 1 })).toBe('giveup');
  });

  it('thinking-only 且超过上限 → giveup', () => {
    expect(decideThinkingOnlyAction({ ...base, retryCount: 5 })).toBe('giveup');
  });

  it('有 text 输出 → none（正常结果，不重试）', () => {
    expect(decideThinkingOnlyAction({ ...base, hasText: true })).toBe('none');
  });

  it('本轮已发过真实文本（CLI 流式）→ none，即使 final result 无 text', () => {
    expect(decideThinkingOnlyAction({ ...base, textSentToUser: true })).toBe(
      'none',
    );
  });

  it('只发过工具进度卡、没发真实文本 → retry', () => {
    // 回归保护：工具卡不能算用户已收到回复，否则会跳过 thinking-only 重试，
    // 最后只发 usage-only 空卡。
    expect(decideThinkingOnlyAction({ ...base, textSentToUser: false })).toBe(
      'retry',
    );
  });

  it('outputTokens 为 0 → none（空 turn，非 thinking-only）', () => {
    expect(decideThinkingOnlyAction({ ...base, outputTokens: 0 })).toBe('none');
  });

  it('maxRetries=0 时首次就 giveup（禁用重试）', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 0, maxRetries: 0 }),
    ).toBe('giveup');
  });

  it('边界：retryCount 正好等于 maxRetries → giveup', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 2, maxRetries: 2 }),
    ).toBe('giveup');
  });

  it('边界：retryCount 比 maxRetries 小 1 → retry', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 1, maxRetries: 2 }),
    ).toBe('retry');
  });

  it('混合态：hasText 且 textSentToUser 都为 true → none', () => {
    expect(
      decideThinkingOnlyAction({
        ...base,
        hasText: true,
        textSentToUser: true,
      }),
    ).toBe('none');
  });
});
