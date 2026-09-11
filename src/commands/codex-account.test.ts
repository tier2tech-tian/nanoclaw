import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CommandContext } from './types.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('os', async () => ({
  default: {
    ...(await vi.importActual<any>('os')),
    homedir: () => fixture.root,
  },
}));
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => path.join(fixture.root, folder),
}));
vi.mock('../db.js', () => ({}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import {
  handleCodexAccount,
  handleCodexUsage,
  getAccountUsage,
} from './codex-account.js';
import { loadCodexAccounts, prepareCodexAccount } from '../codex-accounts.js';

let ctx: CommandContext;
beforeEach(() => {
  fixture.root = fs.mkdtempSync('/tmp/codex-command-');
  const config = path.join(fixture.root, 'accounts.json');
  vi.stubEnv('NANOCLAW_CODEX_ACCOUNTS_FILE', config);
  fs.mkdirSync(path.join(fixture.root, '.codex'));
  fs.writeFileSync(
    path.join(fixture.root, '.codex/auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'fake-system' }),
  );
  fs.writeFileSync(
    path.join(fixture.root, 'backup.json'),
    JSON.stringify({ OPENAI_API_KEY: 'fake-backup' }),
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      accounts: [
        { name: 'backup', authFile: path.join(fixture.root, 'backup.json') },
      ],
    }),
  );
  const group = {
    name: 'test',
    folder: 'group',
    trigger: '',
    added_at: '',
    containerConfig: { cliMode: 'codex' as const },
  };
  ctx = {
    chatJid: 'fs:test',
    args: 'backup',
    group,
    channel: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    queue: { retireAfterTurn: vi.fn(() => true), killGroup: vi.fn() },
    registeredGroups: { 'fs:test': group },
    sessions: { group: 'existing-thread' },
    setRegisteredGroup: vi.fn(),
    deleteSession: vi.fn(),
  } as unknown as CommandContext;
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

it('手动切号只保存群选择并排水，不写凭据、不删除历史、不终止任务', async () => {
  await handleCodexAccount(ctx);
  expect(ctx.setRegisteredGroup).toHaveBeenCalledWith(
    'fs:test',
    expect.objectContaining({
      containerConfig: { cliMode: 'codex', codexAccount: 'backup' },
    }),
  );
  expect(ctx.queue.retireAfterTurn).toHaveBeenCalledWith('fs:test');
  expect(ctx.queue.killGroup).not.toHaveBeenCalled();
  expect(ctx.deleteSession).not.toHaveBeenCalled();
  expect(ctx.sessions.group).toBe('existing-thread');
  expect(fs.existsSync(path.join(fixture.root, 'group/.codex-home'))).toBe(
    false,
  );
  expect(ctx.channel.sendMessage).toHaveBeenCalledWith(
    'fs:test',
    expect.stringContaining('当前工作不中断'),
  );
});

it('坏账号和auto命令不改变原绑定', async () => {
  fs.writeFileSync(path.join(fixture.root, 'backup.json'), 'secret-invalid');
  await handleCodexAccount(ctx);
  expect(ctx.setRegisteredGroup).not.toHaveBeenCalled();
  expect(
    JSON.stringify(vi.mocked(ctx.channel.sendMessage).mock.calls),
  ).not.toContain('secret-invalid');
  ctx.args = 'auto on';
  await handleCodexAccount(ctx);
  expect(ctx.queue.retireAfterTurn).not.toHaveBeenCalled();
});

it('保存绑定失败不更改内存选择，也不排水', async () => {
  vi.mocked(ctx.setRegisteredGroup).mockImplementation(() => {
    throw new Error('db failed');
  });
  await handleCodexAccount(ctx);
  expect(ctx.group.containerConfig?.codexAccount).toBeUndefined();
  expect(ctx.queue.retireAfterTurn).not.toHaveBeenCalled();
});

it('自定义配置损坏后仍可选择system回退', async () => {
  ctx.group.containerConfig!.codexAccount = 'backup';
  fs.writeFileSync(path.join(fixture.root, 'accounts.json'), 'bad');
  ctx.args = 'system';
  await handleCodexAccount(ctx);
  expect(ctx.setRegisteredGroup).toHaveBeenCalledWith(
    'fs:test',
    expect.objectContaining({
      containerConfig: { cliMode: 'codex', codexAccount: 'system' },
    }),
  );
});

it('无参数usage只取本群快照，all可汇集同账号其他群；无时间戳不可信', async () => {
  const accounts = loadCodexAccounts();
  for (const [folder, pct, time] of [
    ['group', 4, '2026-01-01T00:00:00Z'],
    ['another', 88, '2026-01-02T00:00:00Z'],
  ] as const) {
    const home = path.join(fixture.root, folder, '.codex-home');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.symlinkSync(accounts[0].authFile, path.join(home, 'auth.json'));
    fs.writeFileSync(
      path.join(home, 'sessions/rollout-test.jsonl'),
      JSON.stringify({
        timestamp: time,
        payload: {
          type: 'token_count',
          rate_limits: { primary: { used_percent: pct } },
        },
      }) + '\n',
    );
  }
  ctx.registeredGroups.other = { ...ctx.group, folder: 'another' };
  ctx.args = '';
  await handleCodexUsage(ctx);
  expect(vi.mocked(ctx.channel.sendMessage).mock.calls.at(-1)?.[1]).toContain(
    '4%',
  );
  expect(
    vi.mocked(ctx.channel.sendMessage).mock.calls.at(-1)?.[1],
  ).not.toContain('88%');
  ctx.args = 'all';
  await handleCodexUsage(ctx);
  expect(vi.mocked(ctx.channel.sendMessage).mock.calls.at(-1)?.[1]).toContain(
    '88%',
  );
  fs.writeFileSync(
    path.join(fixture.root, 'group/.codex-home/sessions/rollout-test.jsonl'),
    JSON.stringify({
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 4 } },
      },
    }) + '\n',
  );
  expect(getAccountUsage(accounts[0], [ctx.group]).rateLimits).toBeNull();
});

it('实际生效前usage仍标记系统账号，生效后旧rollout不能作为备用账号配额', async () => {
  const accounts = loadCodexAccounts();
  const home = path.join(fixture.root, 'group/.codex-home');
  fs.mkdirSync(path.join(home, 'sessions/2026'), { recursive: true });
  fs.symlinkSync(accounts[0].authFile, path.join(home, 'auth.json'));
  const file = path.join(home, 'sessions/2026/rollout-test.jsonl');
  const event = (time: string, pct: number) =>
    JSON.stringify({
      timestamp: time,
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: pct } },
      },
    }) + '\n';
  fs.writeFileSync(file, event('2026-01-01T00:00:00Z', 92));
  await handleCodexAccount(ctx);
  ctx.args = '';
  await handleCodexUsage(ctx);
  expect(vi.mocked(ctx.channel.sendMessage).mock.calls.at(-1)?.[1]).toContain(
    '最近生效：system；待生效：backup',
  );
  expect(getAccountUsage(accounts[1], [ctx.group]).rateLimits).toBeNull();
  const binding = prepareCodexAccount(home, accounts[1], true)!;
  expect(getAccountUsage(accounts[1], [ctx.group]).rateLimits).toBeNull();
  fs.appendFileSync(
    file,
    event(new Date(binding.activatedAt + 1000).toISOString(), 7),
  );
  expect(
    getAccountUsage(accounts[1], [ctx.group]).rateLimits?.fiveHourPercent,
  ).toBe(7);
  expect(getAccountUsage(accounts[0], [ctx.group]).rateLimits).toBeNull();
});
