/**
 * 飞书项目数字员工：员工清单加载 + 派活入口。
 *
 * 一个 AI 节点回调对应一个员工（EMPLOYEES_DIR/<id>/employee.json），
 * 一个"员工 × 需求"对应一个虚拟群：jid = meegle:<员工>:<需求ID>，folder = emp-<员工>-<需求ID>。
 * 同一需求再次进入节点命中同一 folder，会话续接。
 */
import fs from 'fs';
import path from 'path';

import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export interface EmployeeManifest {
  id: string;
  name: string;
  /** 员工负责的 AI 节点（hook 按它路由，NanoClaw 只做记录） */
  nodes: Array<{ project_key: string; state_key: string }>;
  /** 观察群 jid（fs:oc_...），员工回复镜像到这里；不配则不镜像 */
  observe_jid?: string;
  /** 从 container/skills 拷进员工 .claude/skills 的公共 skill 白名单 */
  skills?: string[];
  env?: Record<string, string>;
  /** 员工目录绝对路径（加载时填充） */
  dir: string;
}

export const MEEGLE_JID_PREFIX = 'meegle:';

const EMPLOYEE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const WORK_ITEM_ID_RE = /^\d{1,20}$/;
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 扫描 EMPLOYEES_DIR/*\/employee.json；非法清单跳过并告警，不影响其他员工 */
export function loadEmployees(
  employeesDir: string,
): Map<string, EmployeeManifest> {
  const result = new Map<string, EmployeeManifest>();
  if (!employeesDir || !fs.existsSync(employeesDir)) return result;

  for (const entry of fs.readdirSync(employeesDir)) {
    const dir = path.join(employeesDir, entry);
    const manifestPath = path.join(dir, 'employee.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const error = validateManifest(raw, entry);
      if (error) {
        logger.warn({ manifestPath, error }, '[meegle] 员工清单非法，跳过');
        continue;
      }
      result.set(raw.id, { ...raw, dir });
    } catch (err) {
      logger.warn({ manifestPath, err }, '[meegle] 员工清单解析失败，跳过');
    }
  }
  return result;
}

function validateManifest(raw: unknown, dirName: string): string | null {
  if (!raw || typeof raw !== 'object') return '不是对象';
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !EMPLOYEE_ID_RE.test(m.id))
    return 'id 须为小写字母数字和 -，最长 31';
  if (m.id !== dirName) return `id(${m.id}) 须与目录名(${dirName})一致`;
  if (typeof m.name !== 'string' || !m.name) return '缺 name';
  if (!Array.isArray(m.nodes)) return 'nodes 须为数组';
  if (m.observe_jid !== undefined && typeof m.observe_jid !== 'string')
    return 'observe_jid 须为字符串';
  if (
    m.skills !== undefined &&
    (!Array.isArray(m.skills) ||
      m.skills.some((s) => typeof s !== 'string' || !SKILL_NAME_RE.test(s)))
  )
    return 'skills 须为合法 skill 名数组';
  if (
    m.env !== undefined &&
    (typeof m.env !== 'object' ||
      m.env === null ||
      Object.values(m.env).some((v) => typeof v !== 'string'))
  )
    return 'env 须为字符串映射';
  return null;
}

export function employeeJid(employeeId: string, workItemId: string): string {
  return `${MEEGLE_JID_PREFIX}${employeeId}:${workItemId}`;
}

export function employeeFolder(employeeId: string, workItemId: string): string {
  return `emp-${employeeId}-${workItemId}`;
}

/** 是否数字员工「员工 × 需求」会话（按 folder 前缀识别，不管绑没绑群） */
export function isEmployeeFolder(folder: string): boolean {
  return folder.startsWith('emp-');
}

export function parseEmployeeJid(
  jid: string,
): { employeeId: string; workItemId: string } | null {
  if (!jid.startsWith(MEEGLE_JID_PREFIX)) return null;
  const [employeeId, workItemId] = jid
    .slice(MEEGLE_JID_PREFIX.length)
    .split(':');
  if (!employeeId || !workItemId) return null;
  return { employeeId, workItemId };
}

/**
 * 生成"员工 × 需求"会话配置：独立模式 + 共享账号组，cwd 指向员工目录，员工 bin/ 前插 PATH。
 * 绑定飞书群时 trigger 用机器人名、要求 @ 才处理（群里人互相聊天不打扰员工）。
 */
export function buildEmployeeGroup(
  employee: EmployeeManifest,
  workItemId: string,
  addedAt: string,
  opts: { name?: string; trigger?: string } = {},
): RegisteredGroup {
  return {
    name: opts.name || `${employee.name} · ${workItemId}`,
    folder: employeeFolder(employee.id, workItemId),
    trigger: opts.trigger || `@${employee.id}`,
    added_at: addedAt,
    requiresTrigger: !!opts.trigger,
    customCwd: employee.dir,
    containerConfig: {
      standalone: true,
      sharedOneCLIAgent: true,
      quietProgress: true,
      // 一次回调一轮评审，跑完 1 分钟即退出；同一需求再进来会按 session 续接
      idleTimeout: 60_000,
      env: { ...employee.env, PATH: path.join(employee.dir, 'bin') },
    },
  };
}

/** 把白名单公共 skill 从 container/skills 拷进员工 .claude/skills（覆盖同名，员工私有 skill 不动） */
export function syncEmployeeSkills(
  employee: EmployeeManifest,
  skillsSrcDir: string,
): string[] {
  const copied: string[] = [];
  for (const name of employee.skills || []) {
    const src = path.join(skillsSrcDir, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      logger.warn(
        { employee: employee.id, skill: name },
        '[meegle] 白名单 skill 不存在',
      );
      continue;
    }
    fs.cpSync(src, path.join(employee.dir, '.claude', 'skills', name), {
      recursive: true,
    });
    copied.push(name);
  }
  return copied;
}

export interface MeegleDispatchRequest {
  employee: string;
  work_item_id: string;
  text: string;
  /** 需求名，用于给群起名（hook 查好传来，可缺省） */
  work_item_name?: string;
  /** hook 传来的运行批次：同一批次只入队一次（hook 回包超时重试也不会派两遍） */
  flow_id?: string;
  state_key?: string;
}

/** 员工会话绑定飞书群：首次派活由机器人建群（拉总控等成员），群 = 会话 */
export interface EmployeeGroupBinding {
  /** 机器人名（群里 @ 它才处理），也作为派活消息前缀 */
  trigger: string;
  /** 机器人建群，返回 chat_id；失败抛错 */
  createChat: (name: string) => Promise<string>;
  getBinding: (key: string) => string | undefined;
  setBinding: (key: string, jid: string) => void;
}

export interface MeegleDispatchDeps {
  getEmployee: (id: string) => EmployeeManifest | undefined;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  storeChatMetadata: (jid: string, timestamp: string, name: string) => void;
  storeMessage: (msg: NewMessage) => void;
  skillsSrcDir: string;
  /** 配了就每个"员工 × 需求"绑定一个飞书群；不配则用虚拟会话（meegle:<员工>:<需求>） */
  groupBinding?: EmployeeGroupBinding;
  /** router_state 读写，用于 flow_id 去重 */
  getState?: (key: string) => string | undefined;
  setState?: (key: string, value: string) => void;
  /** 库里最新一条消息的时间（毫秒）；入库时间必须晚于它，message loop 才看得到 */
  latestMessageTime?: () => number;
  now?: () => Date;
}

export type MeegleDispatchResult =
  | {
      ok: true;
      jid: string;
      folder: string;
      created: boolean;
      messageId: string;
      /** 同一 flow_id 之前已入队，这次没再入队 */
      duplicate?: boolean;
    }
  | { ok: false; status: number; error: string };

export function bindingKey(employeeId: string, workItemId: string): string {
  return `meegle:group:${employeeId}:${workItemId}`;
}

/** 同一"员工 × 需求"的派活串行执行：防并发回调各建一个群 */
const dispatchLocks = new Map<string, Promise<unknown>>();

function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = dispatchLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  dispatchLocks.set(key, tail);
  void tail.then(() => {
    if (dispatchLocks.get(key) === tail) dispatchLocks.delete(key);
  });
  return run;
}

export async function dispatchToEmployee(
  req: Partial<MeegleDispatchRequest>,
  deps: MeegleDispatchDeps,
): Promise<MeegleDispatchResult> {
  const employeeId = String(req.employee || '');
  const workItemId = String(req.work_item_id || '');
  const text = typeof req.text === 'string' ? req.text : '';
  if (!text.trim()) return { ok: false, status: 400, error: '缺 text' };
  if (!WORK_ITEM_ID_RE.test(workItemId))
    return { ok: false, status: 400, error: 'work_item_id 须为数字' };
  const employee = deps.getEmployee(employeeId);
  if (!employee)
    return { ok: false, status: 404, error: `员工不存在: ${employeeId}` };

  const folder = employeeFolder(employee.id, workItemId);
  if (!isValidGroupFolder(folder))
    return { ok: false, status: 400, error: `folder 非法: ${folder}` };

  return withKeyLock(bindingKey(employee.id, workItemId), () =>
    dispatchLocked(req, employee, workItemId, text, folder, deps),
  );
}

async function dispatchLocked(
  req: Partial<MeegleDispatchRequest>,
  employee: EmployeeManifest,
  workItemId: string,
  text: string,
  folder: string,
  deps: MeegleDispatchDeps,
): Promise<MeegleDispatchResult> {
  const flowKey = req.flow_id
    ? `meegle:flow:${employee.id}:${req.flow_id}`
    : '';
  const seen = flowKey ? deps.getState?.(flowKey) : undefined;
  if (seen) {
    const prev = JSON.parse(seen) as { jid: string; messageId: string };
    logger.info(
      { employee: employee.id, workItemId, flowId: req.flow_id },
      '[meegle] 同一 flow 已入队过，跳过',
    );
    return {
      ok: true,
      jid: prev.jid,
      folder,
      created: false,
      messageId: prev.messageId,
      duplicate: true,
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  const title = `${employee.name} · ${req.work_item_name || '需求'} #${workItemId}`;

  let jid = employeeJid(employee.id, workItemId);
  const binding = deps.groupBinding;
  if (binding) {
    const key = bindingKey(employee.id, workItemId);
    const bound = binding.getBinding(key);
    if (bound) {
      jid = bound;
    } else {
      try {
        jid = `fs:${await binding.createChat(title)}`;
      } catch (err) {
        // 不降级成虚拟会话：建群失败直接报错，hook 会记 ok=false
        return { ok: false, status: 502, error: `建群失败: ${String(err)}` };
      }
      binding.setBinding(key, jid);
      logger.info(
        { employee: employee.id, workItemId, jid },
        '[meegle] 已建需求群',
      );
    }
  }

  // 以下全同步：入库时间在建群等 await 之后现取，保证晚于库里任何消息，message loop 一定看得到
  const timestamp = new Date(
    Math.max(
      (deps.now ?? (() => new Date()))().getTime(),
      (deps.latestMessageTime?.() ?? 0) + 1,
    ),
  ).toISOString();
  const existing = deps.getGroup(jid);
  // 每次派活都按当前 employee.json 重建配置（改 env/超时等无需重注册），会话按 folder 续接不受影响
  syncEmployeeSkills(employee, deps.skillsSrcDir);
  deps.registerGroup(
    jid,
    buildEmployeeGroup(employee, workItemId, existing?.added_at ?? timestamp, {
      name: binding ? title : undefined,
      trigger: binding?.trigger,
    }),
  );

  const messageId = `meegle-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  deps.storeChatMetadata(jid, timestamp, title);
  deps.storeMessage({
    id: messageId,
    chat_jid: jid,
    sender: 'meegle-hook',
    sender_name: '飞书项目',
    // 绑群时要求 @ 机器人才处理，派活消息带上前缀
    content: binding ? `${binding.trigger} ${text}` : text,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
  if (flowKey) deps.setState?.(flowKey, JSON.stringify({ jid, messageId }));
  // 不主动 enqueue，交给 message loop（2s 一轮）统一发现，避免同一条被送两次
  logger.info(
    {
      employee: employee.id,
      workItemId,
      jid,
      flowId: req.flow_id,
      stateKey: req.state_key,
      created: !existing,
    },
    '[meegle] 派活已入队',
  );
  return { ok: true, jid, folder, created: !existing, messageId };
}
