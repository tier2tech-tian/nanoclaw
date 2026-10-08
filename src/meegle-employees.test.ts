import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MeegleChannel } from './channels/meegle.js';
import {
  dispatchToEmployee,
  loadEmployees,
  MeegleDispatchDeps,
} from './meegle-employees.js';
import type { RegisteredGroup } from './types.js';

let root: string;

function writeEmployee(id: string, manifest: Record<string, unknown>) {
  fs.mkdirSync(path.join(root, 'employees', id), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'employees', id, 'employee.json'),
    JSON.stringify(manifest),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'meegle-emp-'));
  writeEmployee('prd-review', {
    id: 'prd-review',
    name: 'PRD 评审员',
    nodes: [{ project_key: 'p', state_key: 'ai_review' }],
    observe_jid: 'fs:oc_observe',
    skills: ['meegle'],
    env: { LARK_CLI_PROFILE: 'prd-review' },
  });
  fs.mkdirSync(path.join(root, 'skills', 'meegle'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'meegle', 'SKILL.md'), '# meegle');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadEmployees', () => {
  it('加载合法清单，跳过 id 与目录名不一致的', () => {
    writeEmployee('bad', { id: 'other', name: 'x', nodes: [] });
    const employees = loadEmployees(path.join(root, 'employees'));
    expect([...employees.keys()]).toEqual(['prd-review']);
    expect(employees.get('prd-review')?.dir).toBe(
      path.join(root, 'employees', 'prd-review'),
    );
  });

  it('目录不存在返回空', () => {
    expect(loadEmployees(path.join(root, 'nope')).size).toBe(0);
  });
});

describe('dispatchToEmployee', () => {
  function makeDeps() {
    const employees = loadEmployees(path.join(root, 'employees'));
    const groups: Record<string, RegisteredGroup> = {};
    const deps: MeegleDispatchDeps = {
      getEmployee: (id) => employees.get(id),
      getGroup: (jid) => groups[jid],
      registerGroup: vi.fn((jid, group) => {
        groups[jid] = group;
      }),
      storeChatMetadata: vi.fn(),
      storeMessage: vi.fn(),
      skillsSrcDir: path.join(root, 'skills'),
    };
    return { deps, groups };
  }

  it('同一需求两次派活命中同一 folder，配置按清单刷新', async () => {
    const { deps, groups } = makeDeps();
    const req = {
      employee: 'prd-review',
      work_item_id: '7126683372',
      text: '评审',
    };
    const first = await dispatchToEmployee(req, deps);
    const second = await dispatchToEmployee(req, deps);
    expect(first).toMatchObject({
      ok: true,
      created: true,
      jid: 'meegle:prd-review:7126683372',
      folder: 'emp-prd-review-7126683372',
    });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(deps.registerGroup).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(deps.registerGroup).mock.calls;
    expect(calls[1][1].folder).toBe(calls[0][1].folder);
    expect(calls[1][1].added_at).toBe(calls[0][1].added_at);

    const group = groups['meegle:prd-review:7126683372'];
    expect(group.customCwd).toBe(path.join(root, 'employees', 'prd-review'));
    expect(group.requiresTrigger).toBe(false);
    expect(group.containerConfig).toMatchObject({
      standalone: true,
      sharedOneCLIAgent: true,
      idleTimeout: 60_000,
      env: {
        LARK_CLI_PROFILE: 'prd-review',
        PATH: path.join(root, 'employees', 'prd-review', 'bin'),
      },
    });
    // 白名单 skill 拷进员工 .claude/skills
    expect(
      fs.existsSync(
        path.join(
          root,
          'employees',
          'prd-review',
          '.claude',
          'skills',
          'meegle',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });

  it('不同需求各自一个 folder', async () => {
    const { deps } = makeDeps();
    const a = await dispatchToEmployee(
      { employee: 'prd-review', work_item_id: '1', text: 'a' },
      deps,
    );
    const b = await dispatchToEmployee(
      { employee: 'prd-review', work_item_id: '2', text: 'b' },
      deps,
    );
    expect(a.ok && b.ok && a.folder !== b.folder).toBe(true);
  });

  it('非法入参拒绝且不落库', async () => {
    const { deps } = makeDeps();
    expect(
      await dispatchToEmployee(
        { employee: 'nobody', work_item_id: '1', text: 'x' },
        deps,
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await dispatchToEmployee(
        { employee: 'prd-review', work_item_id: '../x', text: 'x' },
        deps,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await dispatchToEmployee(
        { employee: 'prd-review', work_item_id: '1', text: ' ' },
        deps,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(deps.storeMessage).not.toHaveBeenCalled();
  });

  it('绑定飞书群：首次建群并记绑定，再次派活复用同一群；消息带机器人前缀', async () => {
    const { deps, groups } = makeDeps();
    const bindings = new Map<string, string>();
    const createChat = vi.fn(async () => 'oc_new');
    deps.groupBinding = {
      trigger: '@nine-project-dev',
      createChat,
      getBinding: (k) => bindings.get(k),
      setBinding: (k, v) => bindings.set(k, v),
    };
    const req = {
      employee: 'prd-review',
      work_item_id: '42',
      work_item_name: '改入口文案',
      text: '评审',
    };
    const first = await dispatchToEmployee(req, deps);
    const second = await dispatchToEmployee(req, deps);
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat).toHaveBeenCalledWith('PRD 评审员 · 改入口文案 #42');
    expect(first).toMatchObject({ ok: true, jid: 'fs:oc_new', created: true });
    expect(second).toMatchObject({
      ok: true,
      jid: 'fs:oc_new',
      created: false,
    });
    expect(groups['fs:oc_new']).toMatchObject({
      folder: 'emp-prd-review-42',
      requiresTrigger: true,
      trigger: '@nine-project-dev',
    });
    expect(vi.mocked(deps.storeMessage).mock.calls[0][0].content).toBe(
      '@nine-project-dev 评审',
    );
  });

  it('建群失败报错，不降级成虚拟会话、不落消息', async () => {
    const { deps } = makeDeps();
    deps.groupBinding = {
      trigger: '@bot',
      createChat: async () => {
        throw new Error('无建群权限');
      },
      getBinding: () => undefined,
      setBinding: vi.fn(),
    };
    const r = await dispatchToEmployee(
      { employee: 'prd-review', work_item_id: '1', text: 'x' },
      deps,
    );
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(deps.storeMessage).not.toHaveBeenCalled();
    expect(deps.registerGroup).not.toHaveBeenCalled();
  });
});

describe('MeegleChannel', () => {
  it('最终回复镜像到观察群并标注员工与需求，进度消息不镜像', async () => {
    const employees = loadEmployees(path.join(root, 'employees'));
    const forward = vi.fn(async () => 'msg-1');
    const channel = new MeegleChannel((id) => employees.get(id), forward);

    expect(channel.ownsJid('meegle:prd-review:1')).toBe(true);
    expect(channel.ownsJid('fs:oc_x')).toBe(false);

    await channel.sendMessage('meegle:prd-review:1', '进度', {
      isProgress: true,
    });
    expect(forward).not.toHaveBeenCalled();

    await channel.sendMessage('meegle:prd-review:1', '评审完成');
    expect(forward).toHaveBeenCalledWith(
      'fs:oc_observe',
      '[PRD 评审员 · 需求 1]\n评审完成',
    );
  });
});
