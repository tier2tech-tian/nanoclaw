import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  pollQuestionCardIpcOnce,
  processQuestionCardRequest,
} from './question-card-ipc.js';
import { observeQuestionCardToolUse } from './question-card-auth.js';

const request = {
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  chatJid: 'feishu:agent:oc_test',
  title: '确认',
  questions: [{ question: '继续吗？', options: ['继续', '停止'] }],
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createRequestFile(): { ipcBaseDir: string; filePath: string } {
  const ipcBaseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'question-card-ipc-'),
  );
  temporaryDirectories.push(ipcBaseDir);
  const requestDir = path.join(ipcBaseDir, 'session-current', 'question-cards');
  fs.mkdirSync(requestDir, { recursive: true });
  const filePath = path.join(requestDir, `${request.requestId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(request));
  return { ipcBaseDir, filePath };
}

function createIpcDeps() {
  return {
    registeredGroups: () => ({
      [request.chatJid]: {
        name: '测试群',
        folder: 'agent',
        sessionFolder: 'session-current',
        trigger: 'always',
        added_at: new Date().toISOString(),
      },
    }),
    sendQuestionCard: vi.fn().mockResolvedValue('card-late'),
    writeResponse: vi.fn(),
  };
}

describe('问题卡片独立 IPC', () => {
  it('只处理当前会话并返回成功回执', async () => {
    observeQuestionCardToolUse(
      'session-current',
      request.chatJid,
      'mcp__nanoclaw__send_question_card',
      request,
    );
    const sendQuestionCard = vi.fn().mockResolvedValue('card-1');
    const writeResponse = vi.fn();
    await processQuestionCardRequest(request, 'session-current', {
      registeredGroups: () => ({
        [request.chatJid]: {
          name: '测试群',
          folder: 'agent',
          sessionFolder: 'session-current',
          trigger: 'always',
          added_at: new Date().toISOString(),
        },
      }),
      sendQuestionCard,
      writeResponse,
    });

    expect(sendQuestionCard).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: request.chatJid }),
    );
    expect(writeResponse).toHaveBeenCalledWith(
      'session-current',
      request.requestId,
      { cardId: 'card-1' },
    );
  });

  it('同一 Agent 的其他会话也不能越权发卡', async () => {
    const sendQuestionCard = vi.fn();
    const writeResponse = vi.fn();
    await processQuestionCardRequest(request, 'session-other', {
      registeredGroups: () => ({
        [request.chatJid]: {
          name: '测试群',
          folder: 'agent',
          sessionFolder: 'session-current',
          agentId: 'agent',
          trigger: 'always',
          added_at: new Date().toISOString(),
        },
      }),
      sendQuestionCard,
      writeResponse,
    });

    expect(sendQuestionCard).not.toHaveBeenCalled();
    expect(writeResponse).toHaveBeenCalledWith(
      'session-other',
      request.requestId,
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('目录名正确但没有目标 Claude stdout 授权时仍拒绝发卡', async () => {
    const sendQuestionCard = vi.fn();
    const writeResponse = vi.fn();

    await processQuestionCardRequest(request, 'session-current', {
      registeredGroups: () => ({
        [request.chatJid]: {
          name: '测试群',
          folder: 'agent',
          sessionFolder: 'session-current',
          trigger: 'always',
          added_at: new Date().toISOString(),
        },
      }),
      sendQuestionCard,
      writeResponse,
    });

    expect(sendQuestionCard).not.toHaveBeenCalled();
    expect(writeResponse).toHaveBeenCalledWith(
      'session-current',
      request.requestId,
      expect.objectContaining({ error: expect.stringContaining('授权') }),
    );
  });

  it('watcher 在 stdout 授权稍晚到达时保留请求并成功消费', async () => {
    const { ipcBaseDir, filePath } = createRequestFile();
    const deps = createIpcDeps();
    const state = { pendingAuthorizationSince: new Map<string, number>() };

    await pollQuestionCardIpcOnce(deps, state, {
      ipcBaseDir,
      now: () => 1_000,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(deps.writeResponse).not.toHaveBeenCalled();

    observeQuestionCardToolUse(
      'session-current',
      request.chatJid,
      'mcp__nanoclaw__send_question_card',
      request,
    );
    await pollQuestionCardIpcOnce(deps, state, {
      ipcBaseDir,
      now: () => 2_000,
    });
    expect(deps.sendQuestionCard).toHaveBeenCalledOnce();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('watcher 的授权宽限不受请求文件 mtime 刷新影响', async () => {
    const { ipcBaseDir, filePath } = createRequestFile();
    const deps = createIpcDeps();
    const state = { pendingAuthorizationSince: new Map<string, number>() };

    await pollQuestionCardIpcOnce(deps, state, {
      ipcBaseDir,
      now: () => 1_000,
    });
    fs.utimesSync(filePath, new Date(), new Date());
    await pollQuestionCardIpcOnce(deps, state, {
      ipcBaseDir,
      now: () => 3_999,
    });
    expect(fs.existsSync(filePath)).toBe(true);

    fs.utimesSync(filePath, new Date(), new Date());
    await pollQuestionCardIpcOnce(deps, state, {
      ipcBaseDir,
      now: () => 4_000,
    });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(deps.sendQuestionCard).not.toHaveBeenCalled();
    expect(deps.writeResponse).toHaveBeenCalledWith(
      'session-current',
      request.requestId,
      expect.objectContaining({ error: expect.stringContaining('授权') }),
    );
  });

  it('拒绝可逃逸响应目录的 requestId', async () => {
    const sendQuestionCard = vi.fn();
    const writeResponse = vi.fn();

    await processQuestionCardRequest(
      { ...request, requestId: '../outside' },
      'session-current',
      {
        registeredGroups: () => ({}),
        sendQuestionCard,
        writeResponse,
      },
    );

    expect(sendQuestionCard).not.toHaveBeenCalled();
    expect(writeResponse).not.toHaveBeenCalled();
  });
});
