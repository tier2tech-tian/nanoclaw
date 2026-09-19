import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as db from '../../../src/db.js';
import {
  __testing,
  finalizeDelegationOnTurnEnd,
  startIpcWatcher,
  type IpcDeps,
} from '../../../src/ipc.js';
import type { DelegationStatus, RegisteredGroup } from '../../../src/types.js';

const fixture = vi.hoisted(() => ({
  root: '',
  tools: new Map<string, (args: any) => Promise<any>>(),
}));
vi.mock('../../../src/config.js', async (original) => {
  const config = await original<typeof import('../../../src/config.js')>();
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-roundtrip-'));
  return { ...config, DATA_DIR: fixture.root };
});
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: any) => Promise<any>,
    ) {
      fixture.tools.set(name, handler);
    }
    async connect() {}
  },
}));

const groups: Record<string, RegisteredGroup> = Object.fromEntries(
  ['source', 'target', 'other', 'main'].map((folder) => [
    `fs:oc_${folder}`,
    {
      folder,
      name: folder,
      trigger: '@bot',
      added_at: '2026-09-19',
      isMain: folder === 'main',
    },
  ]),
);
const ipcDir = () => path.join(fixture.root, 'ipc', 'source');
const send = vi.fn().mockResolvedValue('om_sent');
const deps = { sendMessage: send } as unknown as IpcDeps;

beforeAll(async () => {
  vi.stubEnv('NANOCLAW_IPC_DIR', ipcDir());
  vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'source');
  vi.stubEnv('NANOCLAW_CHAT_JID', 'fs:oc_source');
  await import('./ipc-mcp-stdio.js');
});
beforeEach(() => {
  db._initTestDatabase();
  for (const [jid, group] of Object.entries(groups))
    db.storeChatMetadata(
      jid,
      new Date().toISOString(),
      group.name,
      'mock',
      true,
    );
  send.mockReset().mockResolvedValue('om_sent');
  fs.mkdirSync(path.join(ipcDir(), 'messages'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(path.join(fixture.root, 'ipc'), { recursive: true, force: true });
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function existing(status: DelegationStatus = 'question') {
  const task = db.createDelegation({
    sourceGroup: 'source',
    sourceJid: 'fs:oc_source',
    targetGroup: 'target',
    targetJid: 'fs:oc_target',
    title: '原任务',
  });
  db.updateDelegationOnReport({
    taskId: task.taskId,
    status,
    summary: '等答复',
  });
  return task;
}
function start(args: object = {}) {
  const result = fixture.tools.get('delegate')!({
    target: 'fs:oc_target',
    text: '继续原任务',
    ...args,
  });
  const requestFile = fs
    .readdirSync(path.join(ipcDir(), 'messages'))
    .find((f) => f.endsWith('.json'))!;
  const request = JSON.parse(
    fs.readFileSync(path.join(ipcDir(), 'messages', requestFile), 'utf8'),
  );
  return { result, request, requestFile };
}
const count = () =>
  db.getDb().prepare('SELECT COUNT(*) n FROM delegation_tasks').get();
const messages = () =>
  db.getDb().prepare('SELECT chat_jid, content FROM messages').all();
async function roundtrip(args: object = {}) {
  const started = start(args);
  await __testing.handleDelegateRequest(
    started.request,
    'source',
    groups,
    deps,
  );
  // 此帮助函数直接调处理器，补上 watcher 的请求移除行为。
  fs.unlinkSync(path.join(ipcDir(), 'messages', started.requestFile));
  return await started.result;
}

describe('派工工具与后台文件回执', () => {
  it('后台未处理时工具不能提前成功，发送入库后才确认', async () => {
    const { request, result } = start();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(messages()).toEqual([]);
    await __testing.handleDelegateRequest(request, 'source', groups, deps);
    expect(await result).toMatchObject({ isError: false });
    expect(messages()).toHaveLength(1);
    expect(count()).toEqual({ n: 1 });
  });

  it('刚派发未汇报时，按拒绝提示用原编号追加可成功且两条内容均入库', async () => {
    expect((await roundtrip({ text: '第一单' })).isError).toBe(false);
    const task = db.getActiveDelegationByGroup('target')!;
    expect(task.status).toBe('dispatched');
    const rejected = await roundtrip({ text: '追加要求' });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain(`task_id="${task.taskId}"`);
    const resumed = await roundtrip({ text: '追加要求', task_id: task.taskId });
    expect(resumed.isError).toBe(false);
    expect(db.getDelegation(task.taskId)?.status).toBe('progress');
    expect(count()).toEqual({ n: 1 });
    expect(messages()).toEqual([
      { chat_jid: 'fs:oc_target', content: `[task_id:${task.taskId}]\n第一单` },
      {
        chat_jid: 'fs:oc_target',
        content: `[task_id:${task.taskId}]\n追加要求`,
      },
    ]);
  });

  it('阶段结束不关单 → 拒绝另建 → 原号续投 → 显式完成，账本与源群消息一致', async () => {
    expect((await roundtrip()).isError).toBe(false);
    const task = db.getActiveDelegationByGroup('target')!;
    __testing.handleReport(
      { status: 'progress', summary: '70/1009，继续采集' },
      'target',
      groups,
    );
    expect(finalizeDelegationOnTurnEnd('target', true, '下一批继续')).toBe(
      true,
    );
    expect(db.getDelegation(task.taskId)?.status).toBe('blocked');
    expect((await roundtrip()).isError).toBe(true);
    expect((await roundtrip({ task_id: task.taskId })).isError).toBe(false);
    expect(db.getDelegation(task.taskId)?.status).toBe('progress');
    __testing.handleReport(
      { status: 'done', summary: '全部验收完成' },
      'target',
      groups,
    );
    expect(finalizeDelegationOnTurnEnd('target', true)).toBe(false);
    expect(db.getDelegation(task.taskId)?.status).toBe('done');
    expect(db.getActiveDelegationByGroup('target')).toBeUndefined();
    expect(count()).toEqual({ n: 1 });
    const reports = (
      messages() as Array<{ chat_jid: string; content: string }>
    ).filter((r) => r.chat_jid === 'fs:oc_source');
    expect(reports.map((r) => r.content)).toEqual([
      expect.stringContaining('｜progress】70/1009'),
      expect.stringContaining('｜blocked】子群本轮已结束，但任务未确认完成'),
      expect.stringContaining('｜done】全部验收完成'),
    ]);
  });

  it('等待答复仍占槽，新建被拒必须返回错误与原任务号', async () => {
    const task = existing();
    const result = await roundtrip();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(task.taskId);
    expect(result.content[0].text).toContain('task_id=');
    expect(db.getDelegation(task.taskId)?.status).toBe('question');
    expect(messages()).toEqual([]);
    expect(count()).toEqual({ n: 1 });
  });

  it.each(['dispatched', 'question', 'blocked', 'progress'] as const)(
    '显式续投 %s 沿用任务号、不增账本且真实入库',
    async (status) => {
      const task = existing(status);
      const result = await roundtrip({ task_id: task.taskId });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('已续投');
      expect(db.getDelegation(task.taskId)?.status).toBe('progress');
      expect(count()).toEqual({ n: 1 });
      expect(messages()).toEqual([
        {
          chat_jid: 'fs:oc_target',
          content: `[task_id:${task.taskId}]\n继续原任务`,
        },
      ]);
    },
  );

  it.each(['closed', 'done', 'failed'] as const)(
    '%s 任务不能续投',
    async (status) => {
      const task = existing(status);
      expect((await roundtrip({ task_id: task.taskId })).isError).toBe(true);
      expect(db.getDelegation(task.taskId)?.status).toBe(status);
      expect(messages()).toEqual([]);
    },
  );

  it('不能伪造 sourceGroup 来续投其他群任务', async () => {
    const task = existing();
    const result = await __testing.handleDelegateRequest(
      {
        target: 'fs:oc_target',
        text: '越权',
        task_id: task.taskId,
        sourceGroup: 'source',
      } as any,
      'other',
      groups,
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('无权'),
    });
    expect(db.getDelegation(task.taskId)?.status).toBe('question');
    expect(count()).toEqual({ n: 1 });
    expect(send.mock.calls.some(([jid]) => jid === 'fs:oc_target')).toBe(false);
    expect(messages()).toEqual([]);
  });

  it('主群可续投原任务但不能更换目标', async () => {
    const task = existing();
    const args = { target: 'fs:oc_other', text: '继续', task_id: task.taskId };
    expect(
      (await __testing.handleDelegateRequest(args, 'main', groups, deps)).ok,
    ).toBe(false);
    expect(
      (
        await __testing.handleDelegateRequest(
          { ...args, target: 'fs:oc_target' },
          'main',
          groups,
          deps,
        )
      ).ok,
    ).toBe(true);
    expect(count()).toEqual({ n: 1 });
  });

  it.each(['发送', '入库'])(
    '续投%s失败返回错误且不关闭原任务',
    async (failure) => {
      const task = existing();
      if (failure === '发送') send.mockRejectedValueOnce(new Error('网络失败'));
      else
        vi.spyOn(db, 'storeMessageDirect').mockImplementationOnce(() => {
          throw new Error('磁盘满');
        });
      expect((await roundtrip({ task_id: task.taskId })).isError).toBe(true);
      expect(db.getDelegation(task.taskId)?.status).toBe('question');
      expect(messages()).toEqual([]);
    },
  );

  it('源群通知失败不把已投递任务误报失败', async () => {
    send
      .mockResolvedValueOnce('om_target')
      .mockRejectedValueOnce(new Error('通知失败'));
    expect((await roundtrip()).isError).toBe(false);
    expect(messages()).toHaveLength(1);
  });

  it('续投发送期间收到终态，不复活原任务', async () => {
    const task = existing();
    send.mockImplementationOnce(async () => {
      db.closeDelegation(task.taskId);
      return 'om_sent';
    });
    expect((await roundtrip({ task_id: task.taskId })).isError).toBe(false);
    expect(db.getDelegation(task.taskId)?.status).toBe('closed');
  });

  it('等待回执超时明确未知，不能返回已派工或自动重派', async () => {
    vi.useFakeTimers();
    const { result } = start();
    await vi.advanceTimersByTimeAsync(30_100);
    expect(await result).toMatchObject({ isError: true });
    expect((await result).content[0].text).toContain('尚未确认');
    expect(count()).toEqual({ n: 0 });
    expect(fs.readdirSync(path.join(ipcDir(), 'messages'))).toHaveLength(1);
  });

  it('后台已投递但回执迟到，工具返回未知且不会再次派工', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    send.mockResolvedValueOnce('om_target').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { request, result } = start();
    const processing = __testing.handleDelegateRequest(
      request,
      'source',
      groups,
      deps,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(messages()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_100);
    expect((await result).isError).toBe(true);
    expect((await result).content[0].text).toContain('尚未确认');
    release();
    await processing;
    expect(count()).toEqual({ n: 1 });
    expect(messages()).toHaveLength(1);
    expect(
      send.mock.calls.filter(([jid]) => jid === 'fs:oc_target'),
    ).toHaveLength(1);
  });

  it('无效请求编号不能写出响应目录，也不能派工', async () => {
    expect(
      (
        await __testing.handleDelegateRequest(
          { target: 'fs:oc_target', text: '任务', requestId: '../escape' },
          'source',
          groups,
          deps,
        )
      ).ok,
    ).toBe(false);
    expect(count()).toEqual({ n: 0 });
  });

  it('旧客户端不带requestId仍可派工，缺少text则失败', async () => {
    expect(
      (
        await __testing.handleDelegateRequest(
          { target: 'fs:oc_target' },
          'source',
          groups,
          deps,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await __testing.handleDelegateRequest(
          { target: 'fs:oc_target', text: '旧版派工' },
          'source',
          groups,
          deps,
        )
      ).ok,
    ).toBe(true);
    expect(count()).toEqual({ n: 1 });
  });
  it('实际 watcher 从目录取来源并返回拒绝，合法续投随后通过', async () => {
    vi.useFakeTimers();
    try {
      const task = existing();
      const other = path.join(fixture.root, 'ipc', 'other');
      fs.mkdirSync(path.join(other, 'messages'), { recursive: true });
      fs.writeFileSync(
        path.join(other, 'messages', 'spoof.json'),
        JSON.stringify({
          type: 'delegate',
          target: 'fs:oc_target',
          text: '伪造来源',
          sourceGroup: 'source',
          task_id: task.taskId,
          requestId: 'spoof-request',
        }),
      );
      startIpcWatcher({ ...deps, registeredGroups: () => groups });
      await vi.advanceTimersByTimeAsync(10);
      const rejected = JSON.parse(
        fs.readFileSync(
          path.join(other, 'responses', 'spoof-request.json'),
          'utf8',
        ),
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain('无权');
      expect(messages()).toEqual([]);
      const { result } = start({ task_id: task.taskId });
      await vi.advanceTimersByTimeAsync(2000);
      expect((await result).isError).toBe(false);
      expect(count()).toEqual({ n: 1 });
      expect(messages()).toHaveLength(1);
      expect(db.getDelegation(task.taskId)?.status).toBe('progress');
    } finally {
      vi.clearAllTimers();
    }
  });
});
