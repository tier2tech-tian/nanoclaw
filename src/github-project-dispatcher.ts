import { execFile } from 'child_process';

export interface GitHubProjectItem {
  projectNumber: number;
  itemId: string;
  status: string;
  title: string;
  body: string;
  url: string;
}

export interface GitHubProjectDispatchState {
  lastStatus: string;
  readyGeneration: number;
  dispatchStatus: 'pending' | 'sent' | 'failed' | 'observed';
}

export type DispatchDecision = {
  action: 'observe' | 'dispatch' | 'retry';
  generation: number;
};

export interface GitHubProjectRoute {
  projectNumber: number;
  taskType: 'Bug' | '需求';
  targetAlias: string;
}

export interface GitHubProjectDispatchConfig {
  routes: GitHubProjectRoute[];
  maxBodyLength: number;
  intervalMs?: number;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface SavedGitHubProjectDispatchState extends GitHubProjectDispatchState {
  projectNumber: number;
  itemId: string;
  targetJid: string | null;
  lastError?: string | null;
  dispatchedAt?: string | null;
}

export interface GitHubProjectDispatchDependencies {
  listProjectItems: (projectNumber: number) => Promise<GitHubProjectItem[]>;
  getState: (
    projectNumber: number,
    itemId: string,
  ) => SavedGitHubProjectDispatchState | undefined;
  saveState: (state: SavedGitHubProjectDispatchState) => void;
  resolveAlias: (alias: string) => string | undefined;
  isRegistered: (jid: string) => boolean;
  canDispatch: (jid: string) => boolean;
  deliver: (input: {
    targetJid: string;
    messageId: string;
    message: string;
  }) => Promise<void>;
  onError?: (error: Error, context: Record<string, unknown>) => void;
  onBlocked?: (context: Record<string, unknown>) => void;
}

export interface GitHubProjectDispatcherLifecycle {
  start: () => void;
  stop: () => void;
  runNow: () => Promise<void>;
}

interface RawProjectItem {
  id?: unknown;
  status?: unknown;
  title?: unknown;
  content?: {
    title?: unknown;
    body?: unknown;
    url?: unknown;
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseProjectItems(
  raw: string,
  projectNumber: number,
  projectUrl: string,
): GitHubProjectItem[] {
  const parsed = JSON.parse(raw) as {
    totalCount?: unknown;
    items?: unknown;
  };
  if (!Array.isArray(parsed.items)) {
    throw new Error(`项目 #${projectNumber} 返回格式缺少 items`);
  }
  const totalCount =
    typeof parsed.totalCount === 'number'
      ? parsed.totalCount
      : parsed.items.length;
  if (totalCount > parsed.items.length) {
    throw new Error(
      `项目 #${projectNumber} 返回 ${parsed.items.length}/${totalCount} 项，结果可能被截断`,
    );
  }

  return (parsed.items as RawProjectItem[]).map((item) => {
    const itemId = asString(item.id);
    if (!itemId) {
      throw new Error(`项目 #${projectNumber} 存在缺少 ID 的事项`);
    }
    return {
      projectNumber,
      itemId,
      status: asString(item.status),
      title: asString(item.content?.title) || asString(item.title),
      body: asString(item.content?.body),
      url: asString(item.content?.url) || projectUrl,
    };
  });
}

export function decideDispatchAction(
  previous: GitHubProjectDispatchState | undefined,
  currentStatus: string,
): DispatchDecision {
  const generation = previous?.readyGeneration ?? 0;
  if (currentStatus !== 'Ready') {
    return { action: 'observe', generation };
  }
  if (!previous || previous.lastStatus !== 'Ready') {
    return { action: 'dispatch', generation: generation + 1 };
  }
  if (
    previous.dispatchStatus === 'failed' ||
    previous.dispatchStatus === 'pending'
  ) {
    return { action: 'retry', generation };
  }
  return { action: 'observe', generation };
}

export function buildDispatchMessage(
  item: GitHubProjectItem,
  taskType: 'Bug' | '需求',
  maxBodyLength: number,
): string {
  const body =
    item.body.length > maxBodyLength
      ? `${item.body.slice(0, maxBodyLength)}…`
      : item.body;
  return [
    'GitHub Project 自动派工',
    `类型：${taskType}`,
    `来源：GitHub Project #${item.projectNumber}`,
    `标题：${item.title}`,
    `链接：${item.url}`,
    '',
    body || '（无正文）',
    '',
    '请执行 kickoff，按项目看板状态完成实现、评审、验证和回写。',
  ].join('\n');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function messageIdFor(item: GitHubProjectItem, generation: number): string {
  return `ipc_github_project_${item.projectNumber}_${item.itemId}_${generation}`;
}

export async function runGitHubProjectDispatchCycle(
  config: GitHubProjectDispatchConfig,
  deps: GitHubProjectDispatchDependencies,
): Promise<void> {
  const claimedTargets = new Map<string, string>();

  for (const route of config.routes) {
    let items: GitHubProjectItem[];
    try {
      items = await deps.listProjectItems(route.projectNumber);
      // External Project failures are isolated per route and retried next poll.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      deps.onError?.(toError(error), { projectNumber: route.projectNumber });
      continue;
    }

    // Claim targets from already-dispatched Ready items before processing new
    // items, so GitHub's item ordering cannot let a later task jump the queue.
    for (const item of items) {
      if (item.status !== 'Ready') continue;
      const previous = deps.getState(item.projectNumber, item.itemId);
      if (
        previous?.dispatchStatus !== 'sent' &&
        previous?.dispatchStatus !== 'pending'
      ) {
        continue;
      }
      const activeTarget =
        previous.targetJid ?? deps.resolveAlias(route.targetAlias);
      if (activeTarget) {
        claimedTargets.set(
          activeTarget,
          `${item.projectNumber}:${item.itemId}`,
        );
      }
    }

    for (const item of items) {
      const previous = deps.getState(item.projectNumber, item.itemId);
      const decision = decideDispatchAction(previous, item.status);
      const baseState = {
        projectNumber: item.projectNumber,
        itemId: item.itemId,
        lastStatus: item.status,
        readyGeneration: decision.generation,
      };

      if (decision.action === 'observe') {
        if (item.status === 'Ready' && previous?.dispatchStatus === 'sent') {
          const activeTarget =
            previous.targetJid ?? deps.resolveAlias(route.targetAlias);
          if (activeTarget) {
            claimedTargets.set(
              activeTarget,
              `${item.projectNumber}:${item.itemId}`,
            );
          }
        }
        deps.saveState({
          ...baseState,
          dispatchStatus:
            item.status === 'Ready'
              ? (previous?.dispatchStatus ?? 'observed')
              : 'observed',
          targetJid: previous?.targetJid ?? null,
          lastError: null,
          dispatchedAt: previous?.dispatchedAt ?? null,
        });
        continue;
      }

      const targetJid = deps.resolveAlias(route.targetAlias);
      let validationError: string | null = null;
      if (!targetJid) {
        validationError = `目标群别名 ${route.targetAlias} 未解析`;
      } else if (!deps.isRegistered(targetJid)) {
        validationError = `目标群 ${route.targetAlias} 未注册`;
      } else if (
        (claimedTargets.has(targetJid) &&
          claimedTargets.get(targetJid) !==
            `${item.projectNumber}:${item.itemId}`) ||
        !deps.canDispatch(targetJid)
      ) {
        validationError = `目标群 ${route.targetAlias} 正在处理其他任务`;
      }

      if (validationError || !targetJid) {
        deps.saveState({
          ...baseState,
          dispatchStatus: 'failed',
          targetJid: targetJid ?? null,
          lastError: validationError,
          dispatchedAt: previous?.dispatchedAt ?? null,
        });
        const context = {
          projectNumber: item.projectNumber,
          itemId: item.itemId,
          targetAlias: route.targetAlias,
          targetJid: targetJid ?? null,
        };
        if (targetJid && validationError?.includes('正在处理其他任务')) {
          deps.onBlocked?.(context);
        } else if (validationError) {
          deps.onError?.(new Error(validationError), context);
        }
        continue;
      }

      // Reserve the route before delivery. A failed first attempt must not let
      // a later Ready item jump the queue in the same cycle.
      claimedTargets.set(targetJid, `${item.projectNumber}:${item.itemId}`);
      deps.saveState({
        ...baseState,
        dispatchStatus: 'pending',
        targetJid,
        lastError: null,
        dispatchedAt: previous?.dispatchedAt ?? null,
      });

      try {
        await deps.deliver({
          targetJid,
          messageId: messageIdFor(item, decision.generation),
          message: buildDispatchMessage(
            item,
            route.taskType,
            config.maxBodyLength,
          ),
        });
        deps.saveState({
          ...baseState,
          dispatchStatus: 'sent',
          targetJid,
          lastError: null,
          dispatchedAt: new Date().toISOString(),
        });
        // Delivery is a retry boundary: persist failure instead of killing loop.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        const err = toError(error);
        deps.saveState({
          ...baseState,
          dispatchStatus: 'pending',
          targetJid,
          lastError: err.message,
          dispatchedAt: previous?.dispatchedAt ?? null,
        });
        deps.onError?.(err, {
          projectNumber: item.projectNumber,
          itemId: item.itemId,
          targetJid,
        });
      }
    }
  }
}

function executeFile(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

export function createGhProjectItemLoader(options: {
  owner: string;
  limit: number;
  execute?: CommandExecutor;
}): (projectNumber: number) => Promise<GitHubProjectItem[]> {
  const execute = options.execute ?? executeFile;
  return async (projectNumber: number) => {
    const { stdout } = await execute(
      'gh',
      [
        'project',
        'item-list',
        String(projectNumber),
        '--owner',
        options.owner,
        '--format',
        'json',
        '--limit',
        String(options.limit),
      ],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseProjectItems(
      stdout,
      projectNumber,
      `https://github.com/orgs/${options.owner}/projects/${projectNumber}`,
    );
  };
}

export function createGitHubProjectDispatcher(
  config: GitHubProjectDispatchConfig,
  deps: GitHubProjectDispatchDependencies,
): GitHubProjectDispatcherLifecycle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runNow = async () => {
    if (running) return;
    running = true;
    try {
      await runGitHubProjectDispatchCycle(config, deps);
      // Keep the polling lifecycle alive even when local state/alias/queue
      // dependencies fail outside the per-route retry boundaries.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      deps.onError?.(toError(error), { stage: 'cycle' });
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (timer) return;
      void runNow();
      timer = setInterval(() => void runNow(), config.intervalMs ?? 60_000);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runNow,
  };
}

export function startGitHubProjectDispatcherIfEnabled(
  enabled: boolean,
  config: GitHubProjectDispatchConfig,
  deps: GitHubProjectDispatchDependencies,
): GitHubProjectDispatcherLifecycle | null {
  if (!enabled) return null;
  const dispatcher = createGitHubProjectDispatcher(config, deps);
  dispatcher.start();
  return dispatcher;
}

export function createGroupQueueWake(queue: {
  enqueueMessageCheck: (jid: string) => void;
  isActive: (jid: string) => boolean;
  closeStdin: (jid: string) => void;
}): (targetJid: string) => Promise<void> {
  return async (targetJid) => {
    queue.enqueueMessageCheck(targetJid);
    if (queue.isActive(targetJid)) {
      queue.closeStdin(targetJid);
    }
  };
}

export function nextDispatchMessageTimestamp(
  currentCursor: string,
  nowMs = Date.now(),
): string {
  const cursorMs = Date.parse(currentCursor);
  const minimumMs = Number.isFinite(cursorMs) ? cursorMs + 1 : 0;
  return new Date(Math.max(nowMs, minimumMs)).toISOString();
}

export function createStoredMessageDelivery(options: {
  storeIfAbsent: (message: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message: boolean;
  }) => boolean;
  sendVisible: (targetJid: string, message: string) => Promise<void>;
  wake: (targetJid: string) => Promise<void>;
  now?: (targetJid: string) => string;
  onVisibleError?: (
    error: Error,
    context: { targetJid: string; messageId: string },
  ) => void;
}): GitHubProjectDispatchDependencies['deliver'] {
  const now = options.now ?? (() => new Date().toISOString());
  return async ({ targetJid, messageId, message }) => {
    const inserted = options.storeIfAbsent({
      id: messageId,
      chat_jid: targetJid,
      sender: 'github-project',
      sender_name: 'GitHub Project',
      content: message,
      timestamp: now(targetJid),
      is_from_me: false,
      is_bot_message: false,
    });
    // Wake on duplicates too: a crash may happen after the durable insert but
    // before queue activation. The stable ID keeps this retry idempotent.
    await options.wake(targetJid);
    if (!inserted) return;

    try {
      await options.sendVisible(targetJid, message);
      // Visible echo is best-effort after the trusted Agent input is durable.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      options.onVisibleError?.(toError(error), { targetJid, messageId });
    }
  };
}
