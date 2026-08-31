import { execFile } from 'child_process';

export interface GitHubProjectItem {
  projectNumber: number;
  itemId: string;
  status: string;
  title: string;
  body: string;
  url: string;
  assignees?: string[];
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
  assignee: string;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface GitHubGraphQLRateLimitSnapshot {
  projectNumber: number;
  cost: number;
  remaining: number;
  resetAt: string;
}

class GitHubGraphQLResponseError extends Error {
  constructor(
    message: string,
    readonly rateLimit?: GitHubGraphQLRateLimitSnapshot,
  ) {
    super(message);
  }
}

class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

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
  assignees?: unknown;
  content?: {
    title?: unknown;
    body?: unknown;
    url?: unknown;
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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
      assignees: asStringArray(item.assignees),
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
    if (
      previous &&
      (previous.dispatchStatus === 'pending' ||
        previous.dispatchStatus === 'failed')
    ) {
      return { action: 'retry', generation };
    }
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
  const configuredAssignee = config.assignee?.trim().toLowerCase();
  if (!configuredAssignee) {
    throw new Error('GitHub Project 自动派工负责人账号不能为空');
  }

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
    const eligibleItems = items.filter((item) =>
      item.assignees?.some(
        (assignee) => assignee.toLowerCase() === configuredAssignee,
      ),
    );
    const eligibleIds = new Set(eligibleItems.map((item) => item.itemId));
    for (const item of items) {
      if (eligibleIds.has(item.itemId)) continue;
      const previous = deps.getState(item.projectNumber, item.itemId);
      if (!previous) continue;
      deps.saveState({
        ...previous,
        lastStatus: `ineligible:${item.status}`,
        dispatchStatus:
          previous.dispatchStatus === 'pending' ||
          previous.dispatchStatus === 'failed'
            ? previous.dispatchStatus
            : 'observed',
        targetJid: null,
        lastError: null,
      });
    }

    // Claim active sent work before unfinished pending work. Claims are
    // first-writer-wins so GitHub item ordering cannot let a later record
    // overwrite the task that already owns this group.
    for (const dispatchStatus of ['sent', 'pending'] as const) {
      for (const item of eligibleItems) {
        if (item.status !== 'Ready') continue;
        const previous = deps.getState(item.projectNumber, item.itemId);
        if (previous?.dispatchStatus !== dispatchStatus) continue;
        const activeTarget =
          previous.targetJid ?? deps.resolveAlias(route.targetAlias);
        if (activeTarget && !claimedTargets.has(activeTarget)) {
          claimedTargets.set(
            activeTarget,
            `${item.projectNumber}:${item.itemId}`,
          );
        }
      }
    }

    for (const item of eligibleItems) {
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
          if (activeTarget && !claimedTargets.has(activeTarget)) {
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
              : previous?.dispatchStatus === 'pending' ||
                  previous?.dispatchStatus === 'failed'
                ? previous.dispatchStatus
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
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new CommandExecutionError(
            error.message,
            String(stdout ?? ''),
            String(stderr ?? ''),
          ),
        );
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });
}

export const PROJECT_ITEMS_QUERY = `
query($owner: String!, $number: Int!, $first: Int!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      items(first: $first, after: $after) {
        totalCount
        nodes {
          id
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }
          assignees: fieldValueByName(name: "Assignees") {
            ... on ProjectV2ItemFieldUserValue {
              users(first: 20) {
                nodes {
                  login
                }
              }
            }
          }
          content {
            ... on DraftIssue {
              title
              body
            }
            ... on Issue {
              title
              body
              url
            }
            ... on PullRequest {
              title
              body
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
  rateLimit {
    cost
    remaining
    resetAt
  }
}
`.trim();

interface RawGraphQLProjectItem {
  id?: unknown;
  status?: { name?: unknown } | null;
  assignees?: {
    users?: { nodes?: Array<{ login?: unknown }> } | null;
  } | null;
  content?: {
    title?: unknown;
    body?: unknown;
    url?: unknown;
  } | null;
}

interface ProjectItemsGraphQLResponse {
  data?: {
    organization?: {
      projectV2?: {
        items?: {
          totalCount?: unknown;
          nodes?: unknown;
          pageInfo?: {
            hasNextPage?: unknown;
            endCursor?: unknown;
          };
        };
      } | null;
    } | null;
    rateLimit?: {
      cost?: unknown;
      remaining?: unknown;
      resetAt?: unknown;
    };
  };
  errors?: unknown;
}

function splitIncludedResponse(raw: string): {
  headers: string;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  const bodyStart = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  });
  if (bodyStart < 0) return { headers: '', body: raw.trim() };
  return {
    headers: lines.slice(0, bodyStart).join('\n'),
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}

function parseRateLimitHeaders(
  raw: string,
): { remaining: number; resetAt: string } | undefined {
  const { headers } = splitIncludedResponse(raw);
  let remaining: number | undefined;
  let resetSeconds: number | undefined;
  for (const line of headers.split('\n')) {
    const remainingMatch = /^x-ratelimit-remaining:\s*(\d+)\s*$/i.exec(line);
    if (remainingMatch) remaining = Number(remainingMatch[1]);
    const resetMatch = /^x-ratelimit-reset:\s*(\d+)\s*$/i.exec(line);
    if (resetMatch) resetSeconds = Number(resetMatch[1]);
  }
  if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(resetSeconds)) {
    return undefined;
  }
  return {
    remaining: remaining as number,
    resetAt: new Date((resetSeconds as number) * 1000).toISOString(),
  };
}

function getCommandErrorOutput(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'stdout' in error &&
    typeof error.stdout === 'string'
  ) {
    return error.stdout;
  }
  return '';
}

function parseRateLimitBody(
  response: ProjectItemsGraphQLResponse,
  projectNumber: number,
): GitHubGraphQLRateLimitSnapshot | undefined {
  const rateLimit = response.data?.rateLimit;
  if (
    !rateLimit ||
    !Number.isSafeInteger(rateLimit.cost) ||
    !Number.isSafeInteger(rateLimit.remaining) ||
    typeof rateLimit.resetAt !== 'string'
  ) {
    return undefined;
  }
  return {
    projectNumber,
    cost: rateLimit.cost as number,
    remaining: rateLimit.remaining as number,
    resetAt: rateLimit.resetAt,
  };
}

function parseGraphQLProjectPage(
  stdout: string,
  projectNumber: number,
): {
  totalCount: number;
  items: RawProjectItem[];
  hasNextPage: boolean;
  endCursor: string | null;
  rateLimit: GitHubGraphQLRateLimitSnapshot;
} {
  const response = JSON.parse(
    splitIncludedResponse(stdout).body,
  ) as ProjectItemsGraphQLResponse;
  const rateLimit = parseRateLimitBody(response, projectNumber);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new GitHubGraphQLResponseError(
      `项目 #${projectNumber} GraphQL 返回错误: ${JSON.stringify(response.errors)}`,
      rateLimit,
    );
  }

  const page = response.data?.organization?.projectV2?.items;
  if (
    !page ||
    !Number.isSafeInteger(page.totalCount) ||
    !Array.isArray(page.nodes) ||
    typeof page.pageInfo?.hasNextPage !== 'boolean'
  ) {
    throw new Error(`项目 #${projectNumber} GraphQL 返回格式不完整`);
  }
  if (!rateLimit || !Number.isFinite(Date.parse(rateLimit.resetAt))) {
    throw new GitHubGraphQLResponseError(
      rateLimit
        ? `项目 #${projectNumber} GraphQL resetAt 无效: ${rateLimit.resetAt}`
        : `项目 #${projectNumber} GraphQL 返回格式缺少 rateLimit`,
      rateLimit,
    );
  }

  const items = (page.nodes as RawGraphQLProjectItem[]).map((item) => ({
    id: item.id,
    status: item.status?.name,
    assignees: item.assignees?.users?.nodes
      ?.map((user) => user.login)
      .filter((login): login is string => typeof login === 'string'),
    content: item.content ?? undefined,
  }));

  return {
    totalCount: page.totalCount as number,
    items,
    hasNextPage: page.pageInfo.hasNextPage,
    endCursor:
      typeof page.pageInfo.endCursor === 'string'
        ? page.pageInfo.endCursor
        : null,
    rateLimit,
  };
}

export function createGhProjectItemLoader(options: {
  owner: string;
  limit: number;
  execute?: CommandExecutor;
  minRemaining?: number;
  now?: () => number;
  onRateLimit?: (snapshot: GitHubGraphQLRateLimitSnapshot) => void;
}): (projectNumber: number) => Promise<GitHubProjectItem[]> {
  const execute = options.execute ?? executeFile;
  const minRemaining = options.minRemaining ?? 100;
  const now = options.now ?? Date.now;
  let blockedUntilMs = 0;
  let blockedResetAt = '';

  const blockUntilReset = (
    projectNumber: number,
    remaining: number,
    resetAt: string,
  ): never => {
    const parsedResetAt = Date.parse(resetAt);
    if (!Number.isFinite(parsedResetAt)) {
      blockedUntilMs = Number.POSITIVE_INFINITY;
      blockedResetAt = `${resetAt}（无效，需进程重启）`;
      throw new Error(
        `项目 #${projectNumber} GitHub GraphQL resetAt 无效，已永久熔断到进程重启: ${resetAt}`,
      );
    }
    blockedUntilMs = parsedResetAt > now() ? parsedResetAt : now();
    blockedResetAt = resetAt;
    throw new Error(
      `项目 #${projectNumber} GitHub GraphQL 配额低水位: remaining=${remaining}, resetAt=${resetAt}`,
    );
  };

  return async (projectNumber: number) => {
    if (now() < blockedUntilMs) {
      throw new Error(`GitHub GraphQL 配额熔断中，重置时间 ${blockedResetAt}`);
    }

    const first = Math.min(100, Math.max(1, options.limit));
    const collected: RawProjectItem[] = [];
    const seenItemIds = new Set<string>();
    const seenCursors = new Set<string>();
    let expectedTotal: number | null = null;
    let after: string | null = null;

    for (;;) {
      const args = [
        'api',
        'graphql',
        '--include',
        '-f',
        `query=${PROJECT_ITEMS_QUERY}`,
        '-F',
        `owner=${options.owner}`,
        '-F',
        `number=${projectNumber}`,
        '-F',
        `first=${first}`,
      ];
      if (after) args.push('-F', `after=${after}`);

      let page: ReturnType<typeof parseGraphQLProjectPage>;
      let responseOutput = '';
      try {
        const { stdout } = await execute('gh', args, {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        responseOutput = stdout;
        page = parseGraphQLProjectPage(stdout, projectNumber);
      } catch (error) {
        const errorOutput = getCommandErrorOutput(error);
        const headerSnapshot = parseRateLimitHeaders(
          responseOutput || errorOutput,
        );
        const bodySnapshot =
          error instanceof GitHubGraphQLResponseError
            ? error.rateLimit
            : undefined;
        const lowWaterSnapshot = [headerSnapshot, bodySnapshot].find(
          (snapshot) =>
            snapshot !== undefined && snapshot.remaining <= minRemaining,
        );
        if (lowWaterSnapshot) {
          blockUntilReset(
            projectNumber,
            lowWaterSnapshot.remaining,
            lowWaterSnapshot.resetAt,
          );
        }
        throw toError(error);
      }
      options.onRateLimit?.(page.rateLimit);

      if (page.rateLimit.remaining <= minRemaining) {
        blockUntilReset(
          projectNumber,
          page.rateLimit.remaining,
          page.rateLimit.resetAt,
        );
      }

      expectedTotal ??= page.totalCount;
      if (page.totalCount !== expectedTotal) {
        throw new Error(
          `项目 #${projectNumber} 翻页期间总数变化: ${expectedTotal} -> ${page.totalCount}`,
        );
      }

      let nextCursor: string | null = null;
      if (page.hasNextPage) {
        if (!page.endCursor) {
          throw new Error(`项目 #${projectNumber} 有下一页但缺少下一页游标`);
        }
        if (seenCursors.has(page.endCursor)) {
          throw new Error(
            `项目 #${projectNumber} 返回重复分页游标: ${page.endCursor}`,
          );
        }
        seenCursors.add(page.endCursor);
        nextCursor = page.endCursor;
      }

      for (const item of page.items) {
        const itemId = asString(item.id);
        if (!itemId) {
          throw new Error(`项目 #${projectNumber} 存在缺少 ID 的事项`);
        }
        if (seenItemIds.has(itemId)) {
          throw new Error(
            `项目 #${projectNumber} 分页返回重复 Item: ${itemId}`,
          );
        }
        seenItemIds.add(itemId);
        collected.push(item);
      }
      if (collected.length > expectedTotal) {
        throw new Error(
          `项目 #${projectNumber} 累计 ${collected.length} 项，超过 totalCount=${expectedTotal}`,
        );
      }

      if (!page.hasNextPage) break;
      after = nextCursor;
    }

    if (collected.length !== expectedTotal) {
      throw new Error(
        `项目 #${projectNumber} 返回 ${collected.length}/${expectedTotal ?? 0} 项，结果可能被截断`,
      );
    }

    return parseProjectItems(
      JSON.stringify({ totalCount: expectedTotal ?? 0, items: collected }),
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
  if (
    currentCursor &&
    (!Number.isFinite(cursorMs) ||
      new Date(cursorMs).toISOString() !== currentCursor)
  ) {
    throw new Error(`目标群游标为非标准 ISO 时间: ${currentCursor}`);
  }
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
