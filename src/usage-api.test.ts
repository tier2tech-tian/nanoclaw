/**
 * /usage 完整流程测试 — mock HTTP + mock DB
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock DB ---
const mockDb = {
  credentials: new Map<string, any>(),
};

vi.mock('./db.js', () => ({
  getOAuthCredential: (name: string) => mockDb.credentials.get(name) ?? null,
  getAllOAuthCredentials: () => Array.from(mockDb.credentials.values()),
  updateOAuthTokens: (name: string, at: string, rt: string, exp: number) => {
    const cred = mockDb.credentials.get(name);
    if (cred) {
      cred.access_token = at;
      cred.refresh_token = rt;
      cred.expires_at = exp;
    }
  },
  updateOAuthUsageCache: (name: string, usage: string | null, error?: string) => {
    const cred = mockDb.credentials.get(name);
    if (cred) {
      cred.cached_usage = usage;
      cred.error_state = error ?? null;
      cred.last_usage_check = Date.now();
    }
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Mock HTTPS ---
type MockResponse = { status: number; body: string };
let httpsMockResponses: MockResponse[] = [];

vi.mock('https', () => ({
  default: {
    request: (_opts: any, callback: (res: any) => void) => {
      const mockRes = httpsMockResponses.shift() || { status: 500, body: '{}' };
      const res = {
        statusCode: mockRes.status,
        on: (event: string, handler: (data?: any) => void) => {
          if (event === 'data') handler(mockRes.body);
          if (event === 'end') handler();
        },
      };
      // 下一个 tick 调 callback，模拟异步
      setTimeout(() => callback(res), 0);
      return {
        on: (_event: string, _handler: any) => {},
        write: (_data: string) => {},
        end: () => {},
      };
    },
  },
}));

// 动态 import 以确保 mock 生效
const { getUsageForSecret, getUsageAll, formatUsage, formatUsageAll, getCurrentSecretName } =
  await import('./usage-api.js');

// --- 辅助函数 ---

function makeCred(name: string, overrides: Record<string, any> = {}) {
  const cred = {
    secret_name: name,
    refresh_token: 'rt_test_' + name,
    access_token: 'at_test_' + name,
    expires_at: Date.now() + 3600_000, // 1h 后过期
    cached_usage: null,
    last_usage_check: null,
    error_state: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  mockDb.credentials.set(name, cred);
  return cred;
}

const MOCK_USAGE_RESPONSE = JSON.stringify({
  five_hour: { utilization: 39.0, resets_at: '2026-04-08T20:00:00Z' },
  seven_day: { utilization: 73.0, resets_at: '2026-04-11T09:00:00Z' },
  seven_day_sonnet: { utilization: 24.0, resets_at: '2026-04-11T17:00:00Z' },
});

const MOCK_TOKEN_RESPONSE = JSON.stringify({
  access_token: 'at_refreshed_new',
  refresh_token: 'rt_rotated_new',
  expires_in: 28800,
});

// --- 测试 ---

beforeEach(() => {
  mockDb.credentials.clear();
  httpsMockResponses = [];
});

describe('getUsageForSecret', () => {
  it('无凭证返回 no_credentials', async () => {
    const result = await getUsageForSecret('nonexistent');
    expect(result.error).toBe('no_credentials');
    expect(result.rateLimits).toBeNull();
  });

  it('正常查询返回 usage 数据', async () => {
    makeCred('anthropic-tian');
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBeUndefined();
    expect(result.rateLimits).not.toBeNull();
    expect(result.rateLimits!.fiveHourPercent).toBe(39);
    expect(result.rateLimits!.weeklyPercent).toBe(73);
    expect(result.rateLimits!.sonnetWeeklyPercent).toBe(24);
  });

  it('缓存命中时不发 HTTP 请求', async () => {
    // cached_usage 存的是 RateLimits 结构（不是原始 API response）
    makeCred('anthropic-tian', {
      cached_usage: JSON.stringify({ fiveHourPercent: 39, weeklyPercent: 73 }),
      last_usage_check: Date.now() - 10_000, // 10 秒前（缓存 TTL 30s）
    });
    // 不 push 任何 mock response — 如果发了请求会因空队列而 500

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBeUndefined();
    expect(result.rateLimits!.fiveHourPercent).toBe(39);
  });

  it('缓存过期后重新查询', async () => {
    makeCred('anthropic-tian', {
      cached_usage: JSON.stringify({ fiveHourPercent: 10, weeklyPercent: 20 }),
      last_usage_check: Date.now() - 60_000, // 60 秒前（超过 30s TTL）
    });
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.rateLimits!.fiveHourPercent).toBe(39); // 新数据
  });

  it('access token 过期时自动刷新', async () => {
    makeCred('anthropic-tian', {
      access_token: 'at_expired',
      expires_at: Date.now() - 1000, // 已过期
    });
    // 第一个请求：token 刷新
    httpsMockResponses.push({ status: 200, body: MOCK_TOKEN_RESPONSE });
    // 第二个请求：usage 查询
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBeUndefined();
    expect(result.rateLimits!.fiveHourPercent).toBe(39);

    // 验证 DB 里的 token 被更新了
    const cred = mockDb.credentials.get('anthropic-tian');
    expect(cred.access_token).toBe('at_refreshed_new');
    expect(cred.refresh_token).toBe('rt_rotated_new');
  });

  it('token 刷新失败返回 auth 错误', async () => {
    makeCred('anthropic-tian', {
      access_token: null,
      expires_at: null,
    });
    httpsMockResponses.push({ status: 401, body: '{"error":"invalid"}' });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBe('auth');
  });

  it('401 时自动刷新重试', async () => {
    makeCred('anthropic-tian');
    // 第一次 usage 查询返回 401
    httpsMockResponses.push({ status: 401, body: '{"error":"expired"}' });
    // token 刷新
    httpsMockResponses.push({ status: 200, body: MOCK_TOKEN_RESPONSE });
    // 重试 usage 查询
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBeUndefined();
    expect(result.rateLimits!.fiveHourPercent).toBe(39);
  });

  it('429 返回缓存数据（如果有）', async () => {
    makeCred('anthropic-tian', {
      cached_usage: JSON.stringify({ fiveHourPercent: 50, weeklyPercent: 80 }),
      last_usage_check: Date.now() - 60_000, // 缓存已过期
    });
    httpsMockResponses.push({ status: 429, body: '{}' });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBe('rate_limited');
    expect(result.stale).toBe(true);
    expect(result.rateLimits!.fiveHourPercent).toBe(50);
  });

  it('429 更新 last_usage_check 防止限流螺旋', async () => {
    makeCred('anthropic-tian', {
      last_usage_check: Date.now() - 60_000,
    });
    httpsMockResponses.push({ status: 429, body: '{}' });

    await getUsageForSecret('anthropic-tian');
    const cred = mockDb.credentials.get('anthropic-tian');
    // last_usage_check 应该被更新为接近当前时间
    expect(Date.now() - cred.last_usage_check).toBeLessThan(5000);
  });

  it('429 无缓存时返回 rate_limited 无数据', async () => {
    makeCred('anthropic-tian');
    httpsMockResponses.push({ status: 429, body: '{}' });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBe('rate_limited');
    expect(result.rateLimits).toBeNull();
  });

  it('网络错误返回 network', async () => {
    makeCred('anthropic-tian');
    httpsMockResponses.push({ status: 500, body: 'Internal Server Error' });

    const result = await getUsageForSecret('anthropic-tian');
    expect(result.error).toBe('network');
  });
});

describe('getUsageAll', () => {
  it('无凭证返回空数组', async () => {
    const results = await getUsageAll();
    expect(results).toEqual([]);
  });

  it('查询多个账号', async () => {
    makeCred('anthropic-tian');
    makeCred('anthropic-Elizabeth');
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });
    httpsMockResponses.push({ status: 200, body: MOCK_USAGE_RESPONSE });

    const results = await getUsageAll();
    expect(results).toHaveLength(2);
    expect(results[0].secretName).toBe('anthropic-tian');
    expect(results[1].secretName).toBe('anthropic-Elizabeth');
  });
});

describe('formatUsage', () => {
  it('格式化正常数据', () => {
    const output = formatUsage({
      secretName: 'anthropic-tian',
      rateLimits: {
        fiveHourPercent: 39,
        weeklyPercent: 73,
        fiveHourResetsAt: '2026-04-08T20:00:00Z',
        weeklyResetsAt: '2026-04-11T09:00:00Z',
        sonnetWeeklyPercent: 24,
        sonnetWeeklyResetsAt: '2026-04-11T17:00:00Z',
      },
    });
    expect(output).toContain('anthropic-tian');
    expect(output).toContain('████░░░░░░'); // 39% → 4 blocks
    expect(output).toContain('39%');
    expect(output).toContain('73%');
    expect(output).toContain('Son:');
    expect(output).toContain('24%');
  });

  it('格式化 no_credentials 错误', () => {
    const output = formatUsage({
      secretName: 'test',
      rateLimits: null,
      error: 'no_credentials',
    });
    expect(output).toContain('未绑定');
    expect(output).toContain('oauth-login.ts');
  });

  it('格式化 auth 错误', () => {
    const output = formatUsage({
      secretName: 'test',
      rateLimits: null,
      error: 'auth',
    });
    expect(output).toContain('失效');
  });

  it('stale 标记显示缓存', () => {
    const output = formatUsage({
      secretName: 'test',
      rateLimits: { fiveHourPercent: 50 },
      stale: true,
      error: 'rate_limited',
    });
    expect(output).toContain('(缓存)');
  });

  it('rate_limited 无数据时显示限流提示', () => {
    const output = formatUsage({
      secretName: 'test',
      rateLimits: null,
      error: 'rate_limited',
    });
    expect(output).toContain('限流');
  });
});

describe('toPercent', () => {
  it('API 返回 0-100 整数时原样保留', async () => {
    makeCred('test-int');
    httpsMockResponses.push({
      status: 200,
      body: JSON.stringify({
        five_hour: { utilization: 39, resets_at: '2026-04-08T20:00:00Z' },
        seven_day: { utilization: 73, resets_at: '2026-04-11T09:00:00Z' },
      }),
    });

    const result = await getUsageForSecret('test-int');
    expect(result.rateLimits!.fiveHourPercent).toBe(39);
    expect(result.rateLimits!.weeklyPercent).toBe(73);
  });
});

describe('formatUsageAll', () => {
  it('标记当前账号', () => {
    const results = [
      { secretName: 'anthropic-tian', rateLimits: { fiveHourPercent: 30 } },
      { secretName: 'anthropic-Elizabeth', rateLimits: { fiveHourPercent: 50 } },
    ];
    const output = formatUsageAll(results, 'anthropic-tian');
    expect(output).toContain('anthropic-tian');
    expect(output).toContain('← 当前');
    // Elizabeth 不标记
    const lines = output.split('\n\n');
    expect(lines[0]).toContain('← 当前');
    expect(lines[1]).not.toContain('← 当前');
  });

  it('空列表提示绑定', () => {
    const output = formatUsageAll([], null);
    expect(output).toContain('未绑定');
  });
});
