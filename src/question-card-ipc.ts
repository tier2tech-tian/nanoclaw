import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';
import { consumeQuestionCardAuthorization } from './question-card-auth.js';
import {
  normalizeQuestionCardDraft,
  type RawQuestionCardDraft,
} from './question-card.js';
import type { RegisteredGroup } from './types.js';

interface QuestionCardRequest {
  requestId: string;
  chatJid: string;
  title: string;
  questions: RawQuestionCardDraft['questions'];
}

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidRequestId(requestId: unknown): requestId is string {
  return typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId);
}

export interface QuestionCardIpcDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendQuestionCard: (input: {
    chatJid: string;
    groupFolder: string;
    draft: ReturnType<typeof normalizeQuestionCardDraft>;
  }) => Promise<string>;
  writeResponse?: (
    sourceGroup: string,
    requestId: string,
    response: Record<string, unknown>,
  ) => void;
}

function writeResponse(
  sourceGroup: string,
  requestId: string,
  response: Record<string, unknown>,
): void {
  if (!isValidRequestId(requestId)) {
    throw new Error('问题卡片 requestId 无效');
  }
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const destination = path.join(responseDir, `${requestId}.json`);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(response));
  fs.renameSync(temporary, destination);
}

export async function processQuestionCardRequest(
  data: QuestionCardRequest,
  sourceGroup: string,
  deps: QuestionCardIpcDeps,
  waitForAuthorization = false,
): Promise<'processed' | 'pending_authorization'> {
  const respond = deps.writeResponse ?? writeResponse;
  if (!isValidRequestId(data?.requestId)) {
    logger.warn({ sourceGroup }, '问题卡片 IPC requestId 无效');
    return 'processed';
  }
  try {
    const targetGroup = deps.registeredGroups()[data.chatJid];
    const targetSession = targetGroup?.folder;
    if (!targetGroup || targetSession !== sourceGroup) {
      throw new Error('只能向当前会话发送问题卡片');
    }
    const draft = normalizeQuestionCardDraft({
      title: data.title,
      questions: data.questions,
    });
    if (!consumeQuestionCardAuthorization(sourceGroup, data.chatJid, draft)) {
      if (waitForAuthorization) return 'pending_authorization';
      throw new Error('问题卡片请求未经当前 Agent 进程授权');
    }
    const cardId = await deps.sendQuestionCard({
      chatJid: data.chatJid,
      groupFolder: sourceGroup,
      draft,
    });
    respond(sourceGroup, data.requestId, { cardId });
    return 'processed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sourceGroup }, '问题卡片 IPC 处理失败');
    respond(sourceGroup, data.requestId, { error: message });
    return 'processed';
  }
}

let watcherRunning = false;

export interface QuestionCardIpcPollState {
  pendingAuthorizationSince: Map<string, number>;
}

const AUTHORIZATION_GRACE_MS = Math.max(2_000, IPC_POLL_INTERVAL * 3);

export async function pollQuestionCardIpcOnce(
  deps: QuestionCardIpcDeps,
  state: QuestionCardIpcPollState,
  options: { ipcBaseDir?: string; now?: () => number } = {},
): Promise<void> {
  const ipcBaseDir = options.ipcBaseDir ?? path.join(DATA_DIR, 'ipc');
  const now = options.now ?? Date.now;

  for (const filePath of state.pendingAuthorizationSince.keys()) {
    if (!fs.existsSync(filePath)) {
      state.pendingAuthorizationSince.delete(filePath);
    }
  }

  const groups = fs.existsSync(ipcBaseDir)
    ? fs
        .readdirSync(ipcBaseDir)
        .filter((entry) =>
          fs.statSync(path.join(ipcBaseDir, entry)).isDirectory(),
        )
    : [];
  for (const sourceGroup of groups) {
    const requestDir = path.join(ipcBaseDir, sourceGroup, 'question-cards');
    if (!fs.existsSync(requestDir)) continue;
    for (const file of fs
      .readdirSync(requestDir)
      .filter((name) => name.endsWith('.json'))) {
      const filePath = path.join(requestDir, file);
      try {
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as QuestionCardRequest;
        const status = await processQuestionCardRequest(
          data,
          sourceGroup,
          deps,
          true,
        );
        if (status === 'pending_authorization') {
          const firstSeenAt =
            state.pendingAuthorizationSince.get(filePath) ?? now();
          state.pendingAuthorizationSince.set(filePath, firstSeenAt);
          if (now() - firstSeenAt < AUTHORIZATION_GRACE_MS) continue;
          await processQuestionCardRequest(data, sourceGroup, deps);
        }
        state.pendingAuthorizationSince.delete(filePath);
        fs.unlinkSync(filePath);
      } catch (err) {
        state.pendingAuthorizationSince.delete(filePath);
        logger.error({ err, filePath }, '问题卡片 IPC 文件处理失败');
        const requestId = path.basename(file, '.json');
        if (isValidRequestId(requestId)) {
          try {
            (deps.writeResponse ?? writeResponse)(sourceGroup, requestId, {
              error: '问题卡片请求格式无效',
            });
          } catch (responseError) {
            logger.error(
              { err: responseError, filePath },
              '问题卡片 IPC 错误回执写入失败',
            );
          }
        }
        fs.unlinkSync(filePath);
      }
    }
  }
}

export function startQuestionCardIpcWatcher(deps: QuestionCardIpcDeps): void {
  if (watcherRunning) return;
  watcherRunning = true;
  const state: QuestionCardIpcPollState = {
    pendingAuthorizationSince: new Map(),
  };

  const poll = async () => {
    try {
      await pollQuestionCardIpcOnce(deps, state);
    } catch (err) {
      logger.error({ err }, '问题卡片 IPC watcher 扫描失败');
    } finally {
      setTimeout(poll, IPC_POLL_INTERVAL);
    }
  };

  void poll();
  logger.info('问题卡片 IPC watcher 已启动');
}
