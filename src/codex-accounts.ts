import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

export interface CodexAccount {
  name: string;
  authFile: string;
}
export interface CodexAccountBinding extends CodexAccount {
  identity: string;
  activatedAt: number;
}
export const CODEX_BINDING_FILE = 'account-binding.json';

export function codexAccountsPath(): string {
  return (
    process.env.NANOCLAW_CODEX_ACCOUNTS_FILE ||
    path.join(os.homedir(), '.config/nanoclaw/codex-accounts.json')
  );
}

export function loadCodexAccounts(
  configFile = codexAccountsPath(),
  home = os.homedir(),
): CodexAccount[] {
  const system = {
    name: 'system',
    authFile: path.join(home, '.codex/auth.json'),
  };
  if (!fs.existsSync(configFile)) return [system];
  let value: unknown;
  try {
    if (fs.statSync(configFile).size > 1024 * 1024) throw new Error();
    value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    throw new Error('Codex账号配置文件无法读取或不是有效JSON');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { accounts?: unknown }).accounts)
  ) {
    throw new Error('Codex账号配置必须包含accounts数组');
  }
  const names = new Set(['system', 'auto', 'all', 'delete']);
  const accounts: CodexAccount[] = [system];
  for (const item of (value as { accounts: unknown[] }).accounts) {
    const record = item as Partial<CodexAccount> | null;
    if (
      !record ||
      typeof record.name !== 'string' ||
      !/^[\p{L}\p{N}_-]{1,40}$/u.test(record.name) ||
      names.has(record.name.toLowerCase())
    ) {
      throw new Error('Codex账号名称无效、重复或使用了保留名称');
    }
    if (typeof record.authFile !== 'string' || !record.authFile.trim())
      throw new Error('Codex账号缺少authFile');
    const authFile = record.authFile.startsWith('~/')
      ? path.join(home, record.authFile.slice(2))
      : record.authFile;
    if (!path.isAbsolute(authFile))
      throw new Error('authFile必须是绝对路径或以~/开头');
    names.add(record.name.toLowerCase());
    accounts.push({ name: record.name, authFile: path.normalize(authFile) });
  }
  return accounts;
}

export function findCodexAccount(
  name: string,
  accounts?: CodexAccount[],
): CodexAccount {
  if (!accounts && name.toLowerCase() === 'system') {
    return {
      name: 'system',
      authFile: path.join(os.homedir(), '.codex/auth.json'),
    };
  }
  const account = (accounts ?? loadCodexAccounts()).find(
    (a) => a.name.toLowerCase() === name.toLowerCase(),
  );
  if (!account) throw new Error('找不到Codex账号，请用/account查看配置');
  return account;
}

export function codexAccountIdentity(account: CodexAccount): string {
  try {
    const stat = fs.statSync(account.authFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
    const auth = JSON.parse(fs.readFileSync(account.authFile, 'utf8'));
    const id =
      typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()
        ? `key:${auth.OPENAI_API_KEY}`
        : typeof auth.tokens?.account_id === 'string' &&
            auth.tokens.account_id &&
            auth.tokens.access_token &&
            auth.tokens.refresh_token
          ? `chatgpt:${auth.tokens.account_id}`
          : null;
    if (!id) throw new Error();
    return createHash('sha256').update(id).digest('hex');
  } catch {
    throw new Error(
      `账号${account.name}的授权文件不可用，请在本机重新登录或检查配置`,
    );
  }
}

export function readCodexAccountBinding(
  codexHome: string,
): CodexAccountBinding | null {
  const file = path.join(codexHome, CODEX_BINDING_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      typeof value.name !== 'string' ||
      typeof value.authFile !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.identity) ||
      !Number.isFinite(value.activatedAt) ||
      value.activatedAt < 0
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('群Codex账号生效记录损坏，请检查后再运行');
  }
}

/** 仅在旧runner退出后的新runner启动阶段调用，不在切号命令中改软链。 */
export function prepareCodexAccount(
  codexHome: string,
  account: CodexAccount,
  explicit: boolean,
): CodexAccountBinding | null {
  const previous = readCodexAccountBinding(codexHome);
  if (!explicit && !previous && account.name === 'system') return null;
  const identity = codexAccountIdentity(account);
  const source = fs.realpathSync(account.authFile);
  fs.mkdirSync(codexHome, { recursive: true });
  const target = path.join(codexHome, 'auth.json');
  let link: string | null = null;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink())
      throw new Error(
        '群auth.json是独立文件，不能自动覆盖；请先在本机备份并处理',
      );
    link = path.resolve(codexHome, fs.readlinkSync(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (path.resolve(target) === path.resolve(account.authFile))
    throw new Error('授权源不能指向群自身auth.json');
  if (
    link === source &&
    previous?.name === account.name &&
    previous.authFile === account.authFile &&
    previous.identity === identity
  )
    return previous;
  const temporary = `${target}.${randomUUID()}.tmp`;
  const recordFile = path.join(codexHome, CODEX_BINDING_FILE);
  const recordTemp = `${recordFile}.${randomUUID()}.tmp`;
  const binding = { ...account, identity, activatedAt: Date.now() };
  try {
    fs.symlinkSync(source, temporary);
    fs.writeFileSync(recordTemp, JSON.stringify(binding), { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.renameSync(recordTemp, recordFile);
  } finally {
    for (const file of [temporary, recordTemp])
      if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return binding;
}
