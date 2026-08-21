import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getMessagesSince,
  getGitHubProjectDispatchState,
  storeMessageDirectIfAbsent,
  storeChatMetadata,
  upsertGitHubProjectDispatchState,
} from './db.js';

describe('GitHub Project 派工状态持久化', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('保存并读取已发送的 Ready 代次', () => {
    upsertGitHubProjectDispatchState({
      projectNumber: 6,
      itemId: 'item-1',
      lastStatus: 'Ready',
      readyGeneration: 1,
      dispatchStatus: 'sent',
      targetJid: 'fs:oc_c3',
      lastError: null,
      dispatchedAt: '2026-08-21T12:00:00.000Z',
    });

    expect(getGitHubProjectDispatchState(6, 'item-1')).toEqual({
      projectNumber: 6,
      itemId: 'item-1',
      lastStatus: 'Ready',
      readyGeneration: 1,
      dispatchStatus: 'sent',
      targetJid: 'fs:oc_c3',
      lastError: null,
      dispatchedAt: '2026-08-21T12:00:00.000Z',
      updatedAt: expect.any(String),
    });
  });

  it('离开 Ready 时保留代次并更新观察状态', () => {
    upsertGitHubProjectDispatchState({
      projectNumber: 7,
      itemId: 'item-2',
      lastStatus: 'Ready',
      readyGeneration: 3,
      dispatchStatus: 'sent',
      targetJid: 'fs:oc_four',
    });
    upsertGitHubProjectDispatchState({
      projectNumber: 7,
      itemId: 'item-2',
      lastStatus: 'Done',
      readyGeneration: 3,
      dispatchStatus: 'observed',
      targetJid: 'fs:oc_four',
    });

    expect(getGitHubProjectDispatchState(7, 'item-2')).toMatchObject({
      lastStatus: 'Done',
      readyGeneration: 3,
      dispatchStatus: 'observed',
    });
  });

  it('不同项目中的同名 item 状态互不覆盖', () => {
    for (const projectNumber of [6, 7]) {
      upsertGitHubProjectDispatchState({
        projectNumber,
        itemId: 'same-id',
        lastStatus: 'Ready',
        readyGeneration: projectNumber,
        dispatchStatus: 'sent',
        targetJid: `fs:oc_${projectNumber}`,
      });
    }

    expect(getGitHubProjectDispatchState(6, 'same-id')?.readyGeneration).toBe(
      6,
    );
    expect(getGitHubProjectDispatchState(7, 'same-id')?.readyGeneration).toBe(
      7,
    );
  });

  it('稳定消息 ID 重试时保留首次内容和时间戳', () => {
    storeChatMetadata(
      'fs:oc_c3',
      '2026-08-21T11:59:00.000Z',
      'C3',
      'feishu',
      true,
    );
    const first = storeMessageDirectIfAbsent({
      id: 'ipc_github_project_6_item-1_1',
      chat_jid: 'fs:oc_c3',
      sender: 'github-project',
      sender_name: 'GitHub Project',
      content: '首次派工',
      timestamp: '2026-08-21T12:00:00.000Z',
      is_from_me: false,
    });
    const second = storeMessageDirectIfAbsent({
      id: 'ipc_github_project_6_item-1_1',
      chat_jid: 'fs:oc_c3',
      sender: 'github-project',
      sender_name: 'GitHub Project',
      content: '不应覆盖',
      timestamp: '2026-08-21T13:00:00.000Z',
      is_from_me: false,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(
      getMessagesSince('fs:oc_c3', '2026-08-21T11:00:00.000Z', 'Andy', 10),
    ).toMatchObject([
      {
        content: '首次派工',
        timestamp: '2026-08-21T12:00:00.000Z',
      },
    ]);
  });
});
