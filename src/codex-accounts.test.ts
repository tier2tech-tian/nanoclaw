import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCodexAccounts,
  prepareCodexAccount,
  findCodexAccount,
} from './codex-accounts.js';

const dirs: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-accounts-'));
  dirs.push(root);
  const config = path.join(root, 'accounts.json');
  const authFile = path.join(root, 'b.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({ OPENAI_API_KEY: 'fake-test-key' }),
  );
  fs.writeFileSync(
    config,
    JSON.stringify({ accounts: [{ name: 'backup', authFile }] }),
  );
  return { root, config, authFile, groupHome: path.join(root, 'group') };
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

describe('Codex账号文件', () => {
  it('无配置保留系统账号，自定义账号读取指定文件而非复制凭据', () => {
    const f = fixture();
    expect(
      loadCodexAccounts(path.join(f.root, 'missing'), f.root).map(
        (a) => a.name,
      ),
    ).toEqual(['system']);
    const accounts = loadCodexAccounts(f.config, f.root);
    expect(accounts.map((a) => a.name)).toEqual(['system', 'backup']);
    const before = fs.readFileSync(f.authFile, 'utf8');
    prepareCodexAccount(f.groupHome, accounts[1], true);
    expect(fs.readlinkSync(path.join(f.groupHome, 'auth.json'))).toBe(
      fs.realpathSync(f.authFile),
    );
    expect(fs.readFileSync(f.authFile, 'utf8')).toBe(before);
  });
  it('未显式配置的系统账号不动已有授权或创建生效记录', () => {
    const f = fixture();
    fs.mkdirSync(f.groupHome);
    const auth = path.join(f.groupHome, 'auth.json');
    fs.writeFileSync(auth, 'legacy');
    const system = loadCodexAccounts(f.config, f.root)[0];
    expect(prepareCodexAccount(f.groupHome, system, false)).toBeNull();
    expect(fs.readFileSync(auth, 'utf8')).toBe('legacy');
    expect(fs.readdirSync(f.groupHome)).toEqual(['auth.json']);
  });
  it('拒绝覆盖独立auth文件，配置异常不暴露原始凭据', () => {
    const f = fixture();
    fs.mkdirSync(f.groupHome);
    fs.writeFileSync(path.join(f.groupHome, 'auth.json'), 'private-original');
    expect(() =>
      prepareCodexAccount(
        f.groupHome,
        loadCodexAccounts(f.config, f.root)[1],
        true,
      ),
    ).toThrow('不能自动覆盖');
    fs.writeFileSync(f.config, '{"secret":"DO-NOT-LEAK",');
    expect(() => loadCodexAccounts(f.config, f.root)).toThrow('不是有效JSON');
    expect(fs.readFileSync(path.join(f.groupHome, 'auth.json'), 'utf8')).toBe(
      'private-original',
    );
  });
  it('授权源间接指向群auth时不会制造环形软链', () => {
    const f = fixture();
    fs.mkdirSync(f.groupHome);
    fs.symlinkSync(f.authFile, path.join(f.groupHome, 'auth.json'));
    const indirect = path.join(f.root, 'indirect.json');
    fs.symlinkSync(path.join(f.groupHome, 'auth.json'), indirect);
    prepareCodexAccount(
      f.groupHome,
      { name: 'indirect', authFile: indirect },
      true,
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(f.groupHome, 'auth.json'), 'utf8'))
        .OPENAI_API_KEY,
    ).toBe('fake-test-key');
  });
  it('自定义配置文件写坏不会影响系统账号解析', () => {
    const f = fixture();
    const previous = process.env.NANOCLAW_CODEX_ACCOUNTS_FILE;
    process.env.NANOCLAW_CODEX_ACCOUNTS_FILE = f.config;
    fs.writeFileSync(f.config, 'bad-config');
    try {
      expect(findCodexAccount('system').name).toBe('system');
    } finally {
      if (previous === undefined)
        delete process.env.NANOCLAW_CODEX_ACCOUNTS_FILE;
      else process.env.NANOCLAW_CODEX_ACCOUNTS_FILE = previous;
    }
  });
  it.each(['system', 'auto', 'all', 'delete', 'bad/name', 'bad\nname'])(
    '配置拒绝保留或非法名称%s',
    (name) => {
      const f = fixture();
      fs.writeFileSync(
        f.config,
        JSON.stringify({ accounts: [{ name, authFile: f.authFile }] }),
      );
      expect(() => loadCodexAccounts(f.config, f.root)).toThrow('名称');
    },
  );
  it('重复名称大小写不敏感，相对路径不能隐式依赖进程目录', () => {
    const f = fixture();
    fs.writeFileSync(
      f.config,
      JSON.stringify({
        accounts: [
          { name: 'B', authFile: f.authFile },
          { name: 'b', authFile: f.authFile },
        ],
      }),
    );
    expect(() => loadCodexAccounts(f.config, f.root)).toThrow('重复');
    fs.writeFileSync(
      f.config,
      JSON.stringify({ accounts: [{ name: 'B', authFile: 'auth.json' }] }),
    );
    expect(() => loadCodexAccounts(f.config, f.root)).toThrow('绝对路径');
  });
  it('同账号重复启动不重置配额边界；更换真实身份则重置，源文件始终不改', () => {
    const f = fixture();
    const a = loadCodexAccounts(f.config, f.root)[1];
    const first = prepareCodexAccount(f.groupHome, a, true)!;
    const record = path.join(f.groupHome, 'account-binding.json');
    const inode = fs.statSync(record).ino;
    expect(prepareCodexAccount(f.groupHome, a, true)).toEqual(first);
    expect(fs.statSync(record).ino).toBe(inode);
    fs.writeFileSync(
      f.authFile,
      JSON.stringify({ OPENAI_API_KEY: 'different-fake' }),
    );
    const second = prepareCodexAccount(f.groupHome, a, true)!;
    expect(second.identity).not.toBe(first.identity);
    expect(JSON.parse(fs.readFileSync(f.authFile, 'utf8')).OPENAI_API_KEY).toBe(
      'different-fake',
    );
  });
});
