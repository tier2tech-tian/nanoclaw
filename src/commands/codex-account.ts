import path from 'path';
import fs from 'fs';
import { CODEX_MODES, resolveCliMode } from '../cli-mode.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  codexAccountIdentity,
  findCodexAccount,
  loadCodexAccounts,
  readCodexAccountBinding,
  type CodexAccount,
} from '../codex-accounts.js';
import {
  formatCodexUsage,
  getCodexUsage,
  type CodexUsageResult,
} from '../codex-usage.js';
import type { RegisteredGroup } from '../types.js';
import type { CommandContext } from './types.js';

function groupHome(group: RegisteredGroup): string {
  return path.join(resolveGroupFolderPath(group.folder), '.codex-home');
}

export async function handleCodexAccount(ctx: CommandContext): Promise<void> {
  const { args, chatJid, channel } = ctx;
  const group = ctx.registeredGroups[chatJid] ?? ctx.group;
  let target: CodexAccount;
  try {
    const accounts =
      args.trim().toLowerCase() === 'system'
        ? [findCodexAccount('system')]
        : loadCodexAccounts();
    const binding = readCodexAccountBinding(groupHome(group));
    const actual = binding?.name ?? 'system';
    const selected = group.containerConfig?.codexAccount ?? 'system';
    if (!args) {
      const lines = accounts.map((account) => {
        let state = '授权文件可读';
        try {
          codexAccountIdentity(account);
        } catch {
          state = '授权文件不可用';
        }
        return `${account.name}${account.name === 'system' ? '（系统账号）' : ''}：${state}${account.name === actual ? '，最近生效' : ''}${account.name === selected ? '，已选' : ''}`;
      });
      await channel.sendMessage(
        chatJid,
        `Codex账号\n${lines.join('\n')}\n${actual !== selected ? `待生效：${actual} → ${selected}\n` : ''}切换：/account <名称>；配额：/usage [all|名称]`,
      );
      return;
    }
    if (/^(auto|delete)(\s|$)/i.test(args)) {
      await channel.sendMessage(
        chatJid,
        'Codex仅支持手动选择账号，不支持自动轮换或从群里删除凭据。',
      );
      return;
    }
    target = findCodexAccount(args.trim(), accounts);
    codexAccountIdentity(target);
    if (selected === target.name) {
      await channel.sendMessage(
        chatJid,
        actual === selected
          ? `已选择${selected}。`
          : `已选择${selected}，等待旧runner退出后下一轮生效。`,
      );
      return;
    }
  } catch (error) {
    await channel.sendMessage(chatJid, (error as Error).message);
    return;
  }
  const updated = {
    ...group,
    containerConfig: { ...group.containerConfig, codexAccount: target.name },
  };
  try {
    ctx.setRegisteredGroup(chatJid, updated);
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, 'Codex账号绑定保存失败');
    await channel.sendMessage(chatJid, '账号绑定保存失败，原绑定未更改。');
    return;
  }
  // 不修改在途任务持有的group对象：同轮错误重试仍必须使用原账号。
  ctx.registeredGroups[chatJid] = updated;
  const waiting = ctx.queue.retireAfterTurn(chatJid);
  logger.info({ chatJid, account: target.name, waiting }, 'Codex账号已选择');
  await channel.sendMessage(
    chatJid,
    `已选择${target.name}。${waiting ? '当前工作不中断，旧runner退出后下一轮生效。' : '下一轮启动时生效。'}会话记录保留，不自动重跑任务。`,
  );
}

/** 只采用能归属到指定账号的快照，不能把切号前的同thread旧事件当成新账号。 */
export function getAccountUsage(
  account: CodexAccount,
  groups: RegisteredGroup[],
): CodexUsageResult {
  let latest: CodexUsageResult | undefined;
  const identity = codexAccountIdentity(account);
  for (const group of groups) {
    if (!CODEX_MODES.includes(resolveCliMode(group.containerConfig))) continue;
    const home = groupHome(group);
    try {
      const binding = readCodexAccountBinding(home);
      if (binding) {
        if (
          binding.name !== account.name ||
          binding.identity !== identity ||
          binding.authFile !== account.authFile
        )
          continue;
      } else if (account.name !== 'system') {
        continue;
      }
      // 受管与旧系统群都必须核对实际授权源。
      if (
        fs.realpathSync(path.join(home, 'auth.json')) !==
        fs.realpathSync(account.authFile)
      )
        continue;
      const result = getCodexUsage(group, binding?.activatedAt);
      if (
        result.rateLimits &&
        result.observedAt &&
        (!latest || (result.observedAt ?? '') > (latest.observedAt ?? ''))
      )
        latest = result;
    } catch {
      // 单群记录损坏不影响其他账号；无可信归属就不显示该群快照。
    }
  }
  return latest ?? { rateLimits: null, error: 'no_data' };
}

export async function handleCodexUsage(ctx: CommandContext): Promise<void> {
  try {
    if (/^delete(\s|$)/i.test(ctx.args)) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        'Codex不支持从群里删除授权文件。',
      );
      return;
    }
    const accounts = loadCodexAccounts();
    const currentGroup = ctx.registeredGroups[ctx.chatJid] ?? ctx.group;
    const actual =
      readCodexAccountBinding(groupHome(currentGroup))?.name ?? 'system';
    const selected = currentGroup.containerConfig?.codexAccount ?? 'system';
    const targets =
      ctx.args === 'all'
        ? accounts
        : [findCodexAccount(ctx.args.trim() || actual, accounts)];
    const groups = [
      ...new Map(
        [...Object.values(ctx.registeredGroups), currentGroup].map((group) => [
          group.folder,
          group,
        ]),
      ).values(),
    ];
    const lines = targets.map((account) => {
      try {
        const result = getAccountUsage(
          account,
          ctx.args ? groups : [currentGroup],
        );
        return `${account.name}${account.name === 'system' ? '（系统账号）' : ''}\n${result.rateLimits ? formatCodexUsage(result) : '暂无可归属的配额数据'}${result.observedAt ? `\n快照时间：${result.observedAt}` : ''}`;
      } catch {
        return `${account.name}：授权文件不可用，无法确认配额归属`;
      }
    });
    await ctx.channel.sendMessage(
      ctx.chatJid,
      `${!ctx.args && actual !== selected ? `最近生效：${actual}；待生效：${selected}\n\n` : ''}${lines.join('\n\n')}`,
    );
  } catch (error) {
    await ctx.channel.sendMessage(ctx.chatJid, (error as Error).message);
  }
}
