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

/** 生成"员工 × 需求"虚拟群：独立模式 + 共享账号组，cwd 指向员工目录，员工 bin/ 前插 PATH */
export function buildEmployeeGroup(
  employee: EmployeeManifest,
  workItemId: string,
  addedAt: string,
): RegisteredGroup {
  return {
    name: `${employee.name} · ${workItemId}`,
    folder: employeeFolder(employee.id, workItemId),
    trigger: `@${employee.id}`,
    added_at: addedAt,
    requiresTrigger: false,
    customCwd: employee.dir,
    containerConfig: {
      standalone: true,
      sharedOneCLIAgent: true,
      quietProgress: true,
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
  /** hook 传来的运行批次，只进日志 */
  flow_id?: string;
  state_key?: string;
}

export interface MeegleDispatchDeps {
  getEmployee: (id: string) => EmployeeManifest | undefined;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  storeChatMetadata: (jid: string, timestamp: string, name: string) => void;
  storeMessage: (msg: NewMessage) => void;
  enqueueMessageCheck: (jid: string) => void;
  skillsSrcDir: string;
  now?: () => Date;
}

export type MeegleDispatchResult =
  | {
      ok: true;
      jid: string;
      folder: string;
      created: boolean;
      messageId: string;
    }
  | { ok: false; status: number; error: string };

export function dispatchToEmployee(
  req: Partial<MeegleDispatchRequest>,
  deps: MeegleDispatchDeps,
): MeegleDispatchResult {
  const employeeId = String(req.employee || '');
  const workItemId = String(req.work_item_id || '');
  const text = typeof req.text === 'string' ? req.text : '';
  if (!text.trim()) return { ok: false, status: 400, error: '缺 text' };
  if (!WORK_ITEM_ID_RE.test(workItemId))
    return { ok: false, status: 400, error: 'work_item_id 须为数字' };
  const employee = deps.getEmployee(employeeId);
  if (!employee)
    return { ok: false, status: 404, error: `员工不存在: ${employeeId}` };

  const jid = employeeJid(employee.id, workItemId);
  const folder = employeeFolder(employee.id, workItemId);
  if (!isValidGroupFolder(folder))
    return { ok: false, status: 400, error: `folder 非法: ${folder}` };

  const now = (deps.now ?? (() => new Date()))();
  const timestamp = now.toISOString();
  const existing = deps.getGroup(jid);
  if (!existing) {
    syncEmployeeSkills(employee, deps.skillsSrcDir);
    deps.registerGroup(
      jid,
      buildEmployeeGroup(employee, workItemId, timestamp),
    );
  }

  const messageId = `meegle-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  deps.storeChatMetadata(jid, timestamp, `${employee.name} · ${workItemId}`);
  deps.storeMessage({
    id: messageId,
    chat_jid: jid,
    sender: 'meegle-hook',
    sender_name: '飞书项目',
    content: text,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
  deps.enqueueMessageCheck(jid);
  logger.info(
    {
      employee: employee.id,
      workItemId,
      flowId: req.flow_id,
      stateKey: req.state_key,
      created: !existing,
    },
    '[meegle] 派活已入队',
  );
  return { ok: true, jid, folder, created: !existing, messageId };
}
