import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDispatchMessage,
  createGhProjectItemLoader,
  createGitHubProjectDispatcher,
  createGroupQueueWake,
  createStoredMessageDelivery,
  decideDispatchAction,
  nextDispatchMessageTimestamp,
  parseProjectItems,
  runGitHubProjectDispatchCycle,
  startGitHubProjectDispatcherIfEnabled,
} from './github-project-dispatcher.js';
import type {
  GitHubProjectItem,
  SavedGitHubProjectDispatchState,
} from './github-project-dispatcher.js';

describe('GitHub Project 自动派工纯逻辑', () => {
  it('派工消息时间戳必须严格晚于目标群游标', () => {
    expect(
      nextDispatchMessageTimestamp('2026-08-21T12:00:00.000Z', 0),
    ).toBe('2026-08-21T12:00:00.001Z');
    expect(nextDispatchMessageTimestamp('', 1_777_777_777_777)).toBe(
      new Date(1_777_777_777_777).toISOString(),
    );
    expect(nextDispatchMessageTimestamp('坏游标', 1_777_777_777_777)).toBe(
      new Date(1_777_777_777_777).toISOString(),
    );
  });

  it('解析 Issue 与 Draft，并保留 Project Item ID', () => {
    const result = parseProjectItems(
      JSON.stringify({
        totalCount: 2,
        items: [
          {
            id: 'item-issue',
            status: 'Ready',
            title: '修复登录失败',
            content: {
              type: 'Issue',
              title: '修复登录失败',
              body: '复现步骤',
              url: 'https://github.com/acme/app/issues/1',
            },
          },
          {
            id: 'item-draft',
            status: 'Backlog',
            title: '新增报表',
            content: { type: 'DraftIssue', body: '需求正文' },
          },
        ],
      }),
      6,
      'https://github.com/orgs/TierIITech/projects/6',
    );

    expect(result).toEqual([
      {
        projectNumber: 6,
        itemId: 'item-issue',
        status: 'Ready',
        title: '修复登录失败',
        body: '复现步骤',
        url: 'https://github.com/acme/app/issues/1',
      },
      {
        projectNumber: 6,
        itemId: 'item-draft',
        status: 'Backlog',
        title: '新增报表',
        body: '需求正文',
        url: 'https://github.com/orgs/TierIITech/projects/6',
      },
    ]);
  });

  it('检测 gh 截断结果而不是静默漏派', () => {
    expect(() =>
      parseProjectItems(
        JSON.stringify({ totalCount: 2, items: [{ id: 'only-one' }] }),
        6,
        'https://github.com/orgs/TierIITech/projects/6',
      ),
    ).toThrow('项目 #6 返回 1/2 项');
  });

  it('拒绝缺少 Project Item ID 的异常结果', () => {
    expect(() =>
      parseProjectItems(
        JSON.stringify({
          totalCount: 1,
          items: [{ status: 'Ready', title: '无 ID 事项' }],
        }),
        6,
        'https://github.com/orgs/TierIITech/projects/6',
      ),
    ).toThrow('项目 #6 存在缺少 ID 的事项');
  });

  it('首次 Ready 产生第一代派工', () => {
    expect(decideDispatchAction(undefined, 'Ready')).toEqual({
      action: 'dispatch',
      generation: 1,
    });
  });

  it('持续 Ready 且已发送时不重复派工', () => {
    expect(
      decideDispatchAction(
        {
          lastStatus: 'Ready',
          readyGeneration: 2,
          dispatchStatus: 'sent',
        },
        'Ready',
      ),
    ).toEqual({ action: 'observe', generation: 2 });
  });

  it('失败的 Ready 在同一代重试', () => {
    expect(
      decideDispatchAction(
        {
          lastStatus: 'Ready',
          readyGeneration: 2,
          dispatchStatus: 'failed',
        },
        'Ready',
      ),
    ).toEqual({ action: 'retry', generation: 2 });
  });

  it('崩溃遗留的 pending Ready 在同一代重试', () => {
    expect(
      decideDispatchAction(
        {
          lastStatus: 'Ready',
          readyGeneration: 2,
          dispatchStatus: 'pending',
        },
        'Ready',
      ),
    ).toEqual({ action: 'retry', generation: 2 });
  });

  it('离开 Ready 后再次进入会生成新一代', () => {
    expect(
      decideDispatchAction(
        {
          lastStatus: 'Backlog',
          readyGeneration: 2,
          dispatchStatus: 'sent',
        },
        'Ready',
      ),
    ).toEqual({ action: 'dispatch', generation: 3 });
  });

  it('非 Ready 只观察，不派工', () => {
    expect(decideDispatchAction(undefined, 'Backlog')).toEqual({
      action: 'observe',
      generation: 0,
    });
  });

  it('派工消息带类型、来源、链接和 kickoff，正文会截断', () => {
    const message = buildDispatchMessage(
      {
        projectNumber: 6,
        itemId: 'item-1',
        status: 'Ready',
        title: '登录失败',
        body: 'a'.repeat(9000),
        url: 'https://github.com/acme/app/issues/1',
      },
      'Bug',
      8000,
    );

    expect(message).toContain('类型：Bug');
    expect(message).toContain('来源：GitHub Project #6');
    expect(message).toContain('https://github.com/acme/app/issues/1');
    expect(message).toContain('请执行 kickoff');
    expect(message.length).toBeLessThan(8500);
    expect(message).toContain('…');
  });
});

describe('GitHub Project CLI 读取', () => {
  it('用 gh 读取完整项目并解析成统一事项', async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        totalCount: 1,
        items: [
          {
            id: 'item-1',
            status: 'Ready',
            title: '修复登录失败',
            content: {
              title: '修复登录失败',
              body: '复现步骤',
              url: 'https://github.com/acme/app/issues/1',
            },
          },
        ],
      }),
    }));
    const load = createGhProjectItemLoader({
      owner: 'TierIITech',
      limit: 1000,
      execute,
    });

    await expect(load(6)).resolves.toMatchObject([
      { projectNumber: 6, itemId: 'item-1', status: 'Ready' },
    ]);
    expect(execute).toHaveBeenCalledWith(
      'gh',
      [
        'project',
        'item-list',
        '6',
        '--owner',
        'TierIITech',
        '--format',
        'json',
        '--limit',
        '1000',
      ],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }),
    );
  });
});

describe('GitHub Project dispatcher 生命周期', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('立即同步，上一轮未完成时跳过重叠轮询，stop 后不再运行', async () => {
    vi.useFakeTimers();
    let resolveList!: (items: GitHubProjectItem[]) => void;
    const listProjectItems = vi.fn(
      () =>
        new Promise<GitHubProjectItem[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const lifecycle = createGitHubProjectDispatcher(
      {
        routes: [{ projectNumber: 6, taskType: 'Bug', targetAlias: 'C3' }],
        maxBodyLength: 8000,
        intervalMs: 1000,
      },
      {
        listProjectItems,
        getState: () => undefined,
        saveState: () => {},
        resolveAlias: () => undefined,
        isRegistered: () => false,
        canDispatch: () => true,
        deliver: async () => {},
      },
    );

    lifecycle.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(listProjectItems).toHaveBeenCalledTimes(1);

    resolveList([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listProjectItems).toHaveBeenCalledTimes(2);

    lifecycle.stop();
    resolveList([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listProjectItems).toHaveBeenCalledTimes(2);
  });

  it('单轮顶层异常会记录但不打死后续轮询', async () => {
    const onError = vi.fn();
    const listProjectItems = vi
      .fn<() => Promise<GitHubProjectItem[]>>()
      .mockResolvedValue([]);
    const saveState = vi.fn(() => {
      throw new Error('数据库暂时不可用');
    });
    listProjectItems.mockResolvedValueOnce([
      {
        projectNumber: 6,
        itemId: 'item-1',
        status: 'Done',
        title: '已完成事项',
        body: '',
        url: 'https://github.com/orgs/TierIITech/projects/6',
      },
    ]);
    const lifecycle = createGitHubProjectDispatcher(
      {
        routes: [{ projectNumber: 6, taskType: 'Bug', targetAlias: 'C3' }],
        maxBodyLength: 8000,
      },
      {
        listProjectItems,
        getState: () => undefined,
        saveState,
        resolveAlias: () => undefined,
        isRegistered: () => false,
        canDispatch: () => true,
        deliver: async () => {},
        onError,
      },
    );

    await expect(lifecycle.runNow()).resolves.toBeUndefined();
    await expect(lifecycle.runNow()).resolves.toBeUndefined();

    expect(listProjectItems).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '数据库暂时不可用' }),
      { stage: 'cycle' },
    );
  });
});

describe('GitHub Project 消息投递', () => {
  it('先以稳定 ID 入库，重复调用不再发送可见通知', async () => {
    const events: string[] = [];
    const storeIfAbsent = vi.fn(() => {
      events.push('store');
      return false;
    });
    storeIfAbsent
      .mockImplementationOnce(() => {
        events.push('store');
        return true;
      })
      .mockImplementationOnce(() => {
        events.push('store');
        return false;
      });
    const sendVisible = vi.fn(async () => {
      events.push('visible');
    });
    const wake = vi.fn(async () => {
      events.push('wake');
    });
    const deliver = createStoredMessageDelivery({
      storeIfAbsent,
      sendVisible,
      wake,
      now: () => '2026-08-21T12:00:00.000Z',
    });
    const input = {
      targetJid: 'fs:oc_c3',
      messageId: 'ipc_github_project_6_item-1_1',
      message: '派工内容',
    };

    await deliver(input);
    await deliver(input);

    expect(storeIfAbsent).toHaveBeenCalledWith({
      id: input.messageId,
      chat_jid: input.targetJid,
      sender: 'github-project',
      sender_name: 'GitHub Project',
      content: input.message,
      timestamp: '2026-08-21T12:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    expect(sendVisible).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(1, input.targetJid);
    expect(wake).toHaveBeenNthCalledWith(2, input.targetJid);
    expect(events).toEqual(['store', 'wake', 'visible', 'store', 'wake']);
  });

  it('可见通知失败不回滚已入库的 Agent 任务', async () => {
    const onVisibleError = vi.fn();
    const deliver = createStoredMessageDelivery({
      storeIfAbsent: () => true,
      sendVisible: async () => {
        throw new Error('飞书发送失败');
      },
      wake: async () => {},
      onVisibleError,
    });

    await expect(
      deliver({
        targetJid: 'fs:oc_c3',
        messageId: 'ipc_github_project_6_item-1_1',
        message: '派工内容',
      }),
    ).resolves.toBeUndefined();
    expect(onVisibleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '飞书发送失败' }),
      expect.objectContaining({ targetJid: 'fs:oc_c3' }),
    );
  });

  it('唤醒失败会让本轮投递失败，下一轮可用相同消息 ID 重试', async () => {
    const wake = vi.fn(async () => {
      throw new Error('队列唤醒失败');
    });
    const deliver = createStoredMessageDelivery({
      storeIfAbsent: () => false,
      sendVisible: async () => {},
      wake,
    });

    await expect(
      deliver({
        targetJid: 'fs:oc_c3',
        messageId: 'ipc_github_project_6_item-1_1',
        message: '派工内容',
      }),
    ).rejects.toThrow('队列唤醒失败');
    expect(wake).toHaveBeenCalledWith('fs:oc_c3');
  });

  it('pending 恢复会同 ID 再唤醒、只入库一次并最终 sent', async () => {
    const states = new Map<string, SavedGitHubProjectDispatchState>();
    const storedIds = new Set<string>();
    const storeIfAbsent = vi.fn((message: { id: string }) => {
      if (storedIds.has(message.id)) return false;
      storedIds.add(message.id);
      return true;
    });
    const wake = vi
      .fn<(jid: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('首次唤醒失败'))
      .mockResolvedValue(undefined);
    const deliver = createStoredMessageDelivery({
      storeIfAbsent,
      wake,
      sendVisible: async () => {},
    });
    const deps = {
      listProjectItems: async () => [
        {
          projectNumber: 6,
          itemId: 'recover-1',
          status: 'Ready',
          title: '恢复验证',
          body: '',
          url: 'https://github.com/orgs/TierIITech/projects/6',
        },
      ],
      getState: (projectNumber: number, itemId: string) =>
        states.get(`${projectNumber}:${itemId}`),
      saveState: (state: SavedGitHubProjectDispatchState) =>
        states.set(`${state.projectNumber}:${state.itemId}`, state),
      resolveAlias: () => 'fs:oc_c3',
      isRegistered: () => true,
      canDispatch: () => true,
      deliver,
    };
    const config = {
      routes: [
        { projectNumber: 6, taskType: 'Bug' as const, targetAlias: 'C3' },
      ],
      maxBodyLength: 8000,
    };

    await runGitHubProjectDispatchCycle(config, deps);
    expect(states.get('6:recover-1')).toMatchObject({
      dispatchStatus: 'pending',
      readyGeneration: 1,
    });
    await runGitHubProjectDispatchCycle(config, deps);

    expect(states.get('6:recover-1')).toMatchObject({
      dispatchStatus: 'sent',
      readyGeneration: 1,
    });
    expect(storeIfAbsent).toHaveBeenCalledTimes(2);
    expect(storedIds).toEqual(new Set(['ipc_github_project_6_recover-1_1']));
    expect(wake).toHaveBeenCalledTimes(2);
  });
});

describe('GitHub Project 自动派工单轮执行', () => {
  const bugItem = {
    projectNumber: 6,
    itemId: 'bug-1',
    status: 'Ready',
    title: '登录失败',
    body: '复现步骤',
    url: 'https://github.com/acme/app/issues/1',
  };
  const requirementItem = {
    projectNumber: 7,
    itemId: 'req-1',
    status: 'Ready',
    title: '新增报表',
    body: '验收标准',
    url: 'https://github.com/acme/app/issues/2',
  };

  function createHarness(options?: { failFirstDelivery?: boolean }) {
    const states = new Map<string, SavedGitHubProjectDispatchState>();
    const deliveries: Array<{
      targetJid: string;
      messageId: string;
      message: string;
    }> = [];
    let deliveryAttempts = 0;
    const deps = {
      listProjectItems: async (projectNumber: number) =>
        projectNumber === 6 ? [bugItem] : [requirementItem],
      getState: (projectNumber: number, itemId: string) =>
        states.get(`${projectNumber}:${itemId}`),
      saveState: (state: SavedGitHubProjectDispatchState) => {
        states.set(`${state.projectNumber}:${state.itemId}`, state);
      },
      resolveAlias: (alias: string) =>
        alias === 'C3'
          ? 'fs:oc_c3'
          : alias === '4号'
            ? 'fs:oc_four'
            : undefined,
      isRegistered: (jid: string) => jid === 'fs:oc_c3' || jid === 'fs:oc_four',
      canDispatch: () => true,
      deliver: async (delivery: (typeof deliveries)[number]) => {
        deliveryAttempts += 1;
        if (options?.failFirstDelivery && deliveryAttempts === 1) {
          throw new Error('飞书暂时不可用');
        }
        deliveries.push(delivery);
      },
    };
    return { states, deliveries, deps };
  }

  const config = {
    routes: [
      { projectNumber: 6, taskType: 'Bug' as const, targetAlias: 'C3' },
      { projectNumber: 7, taskType: '需求' as const, targetAlias: '4号' },
    ],
    maxBodyLength: 8000,
  };

  it('把 #6 派给 C3、#7 派给 4号', async () => {
    const { deps, deliveries } = createHarness();

    await runGitHubProjectDispatchCycle(config, deps);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ targetJid: 'fs:oc_c3' });
    expect(deliveries[0].message).toContain('类型：Bug');
    expect(deliveries[1]).toMatchObject({ targetJid: 'fs:oc_four' });
    expect(deliveries[1].message).toContain('类型：需求');
  });

  it('一个项目查询失败不阻断另一个项目', async () => {
    const { deps, deliveries } = createHarness();
    deps.listProjectItems = async (projectNumber: number) => {
      if (projectNumber === 6) throw new Error('GitHub 暂时不可用');
      return [requirementItem];
    };

    await runGitHubProjectDispatchCycle(config, deps);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].targetJid).toBe('fs:oc_four');
  });

  it('第二轮持续 Ready 不重复投递', async () => {
    const { deps, deliveries } = createHarness();

    await runGitHubProjectDispatchCycle(config, deps);
    await runGitHubProjectDispatchCycle(config, deps);

    expect(deliveries).toHaveLength(2);
  });

  it('投递失败会保持 pending 并在下一轮重试同一消息 ID', async () => {
    const { deps, deliveries, states } = createHarness({
      failFirstDelivery: true,
    });

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );
    expect(states.get('6:bug-1')).toMatchObject({
      dispatchStatus: 'pending',
      readyGeneration: 1,
    });

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].messageId).toBe('ipc_github_project_6_bug-1_1');
  });

  it('目标别名缺失时不投递并保存可重试失败', async () => {
    const { deps, deliveries, states } = createHarness();
    const onError = vi.fn();
    deps.resolveAlias = () => undefined;
    Object.assign(deps, { onError });

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );

    expect(deliveries).toHaveLength(0);
    expect(states.get('6:bug-1')).toMatchObject({
      dispatchStatus: 'failed',
      lastError: '目标群别名 C3 未解析',
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '目标群别名 C3 未解析' }),
      expect.objectContaining({ projectNumber: 6, itemId: 'bug-1' }),
    );
  });

  it('非 Ready 状态只落观察状态', async () => {
    const { deps, deliveries, states } = createHarness();
    deps.listProjectItems = async () => [{ ...bugItem, status: 'Done' }];

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );

    expect(deliveries).toHaveLength(0);
    expect(states.get('6:bug-1')).toMatchObject({
      lastStatus: 'Done',
      dispatchStatus: 'observed',
      readyGeneration: 0,
    });
  });

  it('目标群正在处理任务时保持 failed，空闲后再投递', async () => {
    const { deps, deliveries, states } = createHarness();
    deps.canDispatch = () => false;

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );
    expect(deliveries).toHaveLength(0);
    expect(states.get('6:bug-1')).toMatchObject({
      dispatchStatus: 'failed',
      lastError: '目标群 C3 正在处理其他任务',
    });

    deps.canDispatch = () => true;
    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );
    expect(deliveries).toHaveLength(1);
  });

  it('同一目标群上一事项仍为 Ready 时不派第二项，离开 Ready 后再派', async () => {
    const { deps, deliveries } = createHarness();
    let firstStatus = 'Ready';
    let reverseOrder = false;
    deps.listProjectItems = async () => {
      const items = [
        { ...bugItem, status: firstStatus },
        { ...bugItem, itemId: 'bug-2', title: '第二个 Bug' },
      ];
      return reverseOrder ? items.reverse() : items;
    };
    const bugOnly = { ...config, routes: [config.routes[0]] };

    await runGitHubProjectDispatchCycle(bugOnly, deps);
    reverseOrder = true;
    await runGitHubProjectDispatchCycle(bugOnly, deps);
    expect(deliveries.map((item) => item.messageId)).toEqual([
      'ipc_github_project_6_bug-1_1',
    ]);

    firstStatus = 'In progress';
    await runGitHubProjectDispatchCycle(bugOnly, deps);
    expect(deliveries.map((item) => item.messageId)).toEqual([
      'ipc_github_project_6_bug-1_1',
      'ipc_github_project_6_bug-2_1',
    ]);
  });

  it('同一目标首项投递失败时本轮不允许第二项插队', async () => {
    const { deps, deliveries, states } = createHarness({
      failFirstDelivery: true,
    });
    let reverseOrder = false;
    deps.listProjectItems = async () => {
      const items = [
        bugItem,
        { ...bugItem, itemId: 'bug-2', title: '第二个 Bug' },
      ];
      return reverseOrder ? items.reverse() : items;
    };

    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );

    expect(deliveries).toHaveLength(0);
    expect(states.get('6:bug-1')).toMatchObject({ dispatchStatus: 'pending' });
    expect(states.get('6:bug-2')).toMatchObject({
      dispatchStatus: 'failed',
      lastError: '目标群 C3 正在处理其他任务',
    });

    reverseOrder = true;
    await runGitHubProjectDispatchCycle(
      { ...config, routes: [config.routes[0]] },
      deps,
    );
    expect(deliveries.map((item) => item.messageId)).toEqual([
      'ipc_github_project_6_bug-1_1',
    ]);
  });
});

describe('GitHub Project 启动与队列接线', () => {
  it('默认关闭时不创建轮询，启用后立即执行一次', async () => {
    const listProjectItems = vi.fn(async () => []);
    const deps = {
      listProjectItems,
      getState: () => undefined,
      saveState: () => {},
      resolveAlias: () => undefined,
      isRegistered: () => false,
      canDispatch: () => true,
      deliver: async () => {},
    };
    const config = {
      routes: [
        { projectNumber: 6, taskType: 'Bug' as const, targetAlias: 'C3' },
      ],
      maxBodyLength: 8000,
    };

    expect(
      startGitHubProjectDispatcherIfEnabled(false, config, deps),
    ).toBeNull();
    expect(listProjectItems).not.toHaveBeenCalled();

    const lifecycle = startGitHubProjectDispatcherIfEnabled(true, config, deps);
    await vi.waitFor(() => expect(listProjectItems).toHaveBeenCalledTimes(1));
    lifecycle?.stop();
  });

  it('inactive 只入队，idle-waiting 入队后关闭 stdin 促使立即消费', async () => {
    const events: string[] = [];
    let active = false;
    const wake = createGroupQueueWake({
      enqueueMessageCheck: (jid) => events.push(`enqueue:${jid}`),
      isActive: () => active,
      closeStdin: (jid) => events.push(`close:${jid}`),
    });

    await wake('fs:oc_c3');
    active = true;
    await wake('fs:oc_four');

    expect(events).toEqual([
      'enqueue:fs:oc_c3',
      'enqueue:fs:oc_four',
      'close:fs:oc_four',
    ]);
  });
});
