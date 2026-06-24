/**
 * Agent-runner 启动前健检
 *
 * 三项检查：config 目录完整性、CLI 路径、代理连通性。
 * 对应 OpenSpec: agent-runner-health-check
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import { createRequire } from 'module';
import { redactSensitive } from './error-classify.js';

export interface HealthCheckResult {
  ok: boolean;
  /** 失败时的错误分类 */
  error_class?: 'config_error' | 'network_error';
  /** 失败时的详情 */
  error_detail?: string;
  /** SDK 版本（成功时） */
  sdkVersion?: string;
  /** 解析到的 CLI 路径（成功时） */
  cliPath?: string;
}

type Logger = (msg: string) => void;

// ---- 1. Config 目录完整性 ----

/**
 * 扫描 $CLAUDE_CONFIG_DIR 下的 *.json 条目，
 * 如果是目录则自动删除（自愈）。
 */
function checkConfigDir(configDir: string, log: Logger): { ok: boolean; error?: string } {
  if (!fs.existsSync(configDir)) {
    // 正常首次运行，跳过
    return { ok: true };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configDir);
  } catch {
    return { ok: true };
  }
  if (!stat.isDirectory()) {
    return { ok: true };
  }

  // 遍历一级条目
  let entries: string[];
  try {
    entries = fs.readdirSync(configDir);
  } catch (err) {
    return { ok: false, error: `cannot read config dir: ${(err as Error).message}` };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(configDir, entry);
    try {
      const entryStat = fs.statSync(fullPath);
      if (entryStat.isDirectory()) {
        // *.json 是目录 → 自动清理
        log(`[health] removing corrupted ${entry} (was directory)`);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          log(`[health] removed corrupted ${entry} (was directory)`);
        } catch (rmErr) {
          return {
            ok: false,
            error: `cannot remove corrupted ${entry}: ${(rmErr as Error).message}`,
          };
        }
      }
    } catch {
      // statSync 失败（如 permission denied），跳过
      continue;
    }
  }

  // 特别检查 .claude.json（2026-06-24 事故精确触发路径）
  const claudeJsonPath = path.join(configDir, '.claude.json');
  try {
    const cjStat = fs.statSync(claudeJsonPath);
    if (cjStat.isDirectory()) {
      log(`[health] removing corrupted .claude.json (was directory)`);
      try {
        fs.rmSync(claudeJsonPath, { recursive: true, force: true });
        log(`[health] removed corrupted .claude.json (was directory)`);
      } catch (rmErr) {
        return {
          ok: false,
          error: `cannot remove corrupted .claude.json: ${(rmErr as Error).message}`,
        };
      }
    }
  } catch {
    // 不存在或无法 stat → 正常
  }

  return { ok: true };
}

// ---- 2. CLI 路径解析 ----

interface CliResolveResult {
  ok: boolean;
  cliPath?: string;
  sdkVersion?: string;
  error?: string;
}

function resolveCliPath(log: Logger): CliResolveResult {
  const esmRequire = createRequire(import.meta.url);

  // 使用 require.resolve 自主解析 SDK cli.js 路径
  let cliPath: string;
  try {
    cliPath = esmRequire.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  } catch (err) {
    return { ok: false, error: `SDK cli.js not found: require.resolve failed — ${(err as Error).message}` };
  }

  if (!cliPath) {
    return { ok: false, error: 'SDK cli.js not found: require.resolve returned empty' };
  }

  // 检查文件实际存在
  if (!fs.existsSync(cliPath)) {
    return { ok: false, error: `CLI not found: ${cliPath}` };
  }

  // 读 SDK 版本
  let sdkVersion = 'unknown';
  try {
    const pkgPath = esmRequire.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    sdkVersion = pkg.version || 'unknown';
  } catch {
    // 版本读取失败不阻塞
  }

  log(`[health] SDK version=${sdkVersion} cli=${cliPath}`);
  return { ok: true, cliPath, sdkVersion };
}

// ---- 3. 代理连通性 ----

function getProxyUrl(): string | undefined {
  // 按优先级：HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || undefined;
}

/** 脱敏代理地址（隐藏 userinfo） */
function redactProxyAddr(proxyUrl: string): string {
  return redactSensitive(proxyUrl);
}

function checkProxyConnectivity(
  proxyUrl: string,
  timeoutMs: number,
  log: Logger,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let urlObj: URL;
    try {
      urlObj = new URL(proxyUrl);
    } catch {
      resolve({ ok: false, error: `proxy URL invalid: ${redactProxyAddr(proxyUrl)}` });
      return;
    }

    const port = parseInt(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80);
    const host = urlObj.hostname;
    const redacted = redactProxyAddr(proxyUrl);

    const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
      socket.destroy();
      log(`[health] proxy reachable: ${redacted}`);
      resolve({ ok: true });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: `proxy unreachable: ${redacted}` });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, error: `proxy unreachable: ${redacted} (${err.message})` });
    });
  });
}

// ---- 主入口 ----

const PROXY_TIMEOUT_MS = 5000;

/**
 * 执行三项健检。任一失败返回 ok=false + 错误信息。
 */
export async function runHealthCheck(log: Logger): Promise<HealthCheckResult> {
  // 1. Config 目录完整性
  const configDir = process.env.CLAUDE_CONFIG_DIR || '/workspace/.claude';
  const configResult = checkConfigDir(configDir, log);
  if (!configResult.ok) {
    return {
      ok: false,
      error_class: 'config_error',
      error_detail: configResult.error,
    };
  }

  // 2. CLI 路径解析
  const cliResult = resolveCliPath(log);
  if (!cliResult.ok) {
    return {
      ok: false,
      error_class: 'config_error',
      error_detail: cliResult.error,
    };
  }

  // 3. 代理连通性
  const proxyUrl = getProxyUrl();
  if (proxyUrl) {
    const proxyResult = await checkProxyConnectivity(proxyUrl, PROXY_TIMEOUT_MS, log);
    if (!proxyResult.ok) {
      return {
        ok: false,
        error_class: 'network_error',
        error_detail: proxyResult.error,
      };
    }
  }

  log(`[health] all checks passed, SDK=${cliResult.sdkVersion}`);
  return {
    ok: true,
    sdkVersion: cliResult.sdkVersion,
    cliPath: cliResult.cliPath,
  };
}
