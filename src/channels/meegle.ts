/**
 * 飞书项目数字员工的虚拟频道：只负责 meegle:<员工>:<需求ID> 的出口。
 * 正式产出由员工用 CLI 写回飞书项目；这里把最终回复镜像到员工观察群，观察群只看不驱动。
 */
import { logger } from '../logger.js';
import {
  EmployeeManifest,
  MEEGLE_JID_PREFIX,
  parseEmployeeJid,
} from '../meegle-employees.js';
import type { Channel, SendMessageOptions } from '../types.js';

export class MeegleChannel implements Channel {
  name = 'meegle';

  constructor(
    private getEmployee: (id: string) => EmployeeManifest | undefined,
    /** 转发到真实频道（观察群），由主进程按 jid 找 FeishuChannel */
    private forward: (jid: string, text: string) => Promise<string | undefined>,
  ) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MEEGLE_JID_PREFIX);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined> {
    // 进度消息不镜像，观察群只看结果
    if (options?.isProgress) return undefined;
    const parsed = parseEmployeeJid(jid);
    const employee = parsed && this.getEmployee(parsed.employeeId);
    if (!parsed || !employee?.observe_jid) {
      logger.debug({ jid }, '[meegle] 无观察群，回复不镜像');
      return undefined;
    }
    return this.forward(
      employee.observe_jid,
      `[${employee.name} · 需求 ${parsed.workItemId}]\n${text}`,
    );
  }
}
