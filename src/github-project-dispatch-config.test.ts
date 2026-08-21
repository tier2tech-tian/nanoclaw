import { describe, expect, it } from 'vitest';

import { parseGitHubProjectAutoDispatchConfig } from './config.js';

describe('GitHub Project 自动派工配置', () => {
  it('默认关闭并使用 #6/C3、#7/4号', () => {
    expect(parseGitHubProjectAutoDispatchConfig({})).toEqual({
      enabled: false,
      owner: 'TierIITech',
      intervalMs: 60_000,
      limit: 1000,
      maxBodyLength: 8000,
      routes: [
        { projectNumber: 6, taskType: 'Bug', targetAlias: 'C3' },
        { projectNumber: 7, taskType: '需求', targetAlias: '4号' },
      ],
    });
  });

  it('允许覆盖项目号、别名和轮询周期', () => {
    expect(
      parseGitHubProjectAutoDispatchConfig({
        GITHUB_PROJECT_AUTO_DISPATCH: 'true',
        GITHUB_PROJECT_OWNER: 'Acme',
        GITHUB_PROJECT_POLL_INTERVAL_MS: '120000',
        GITHUB_PROJECT_BUG_NUMBER: '16',
        GITHUB_PROJECT_BUG_TARGET: '修Bug',
        GITHUB_PROJECT_REQUIREMENT_NUMBER: '17',
        GITHUB_PROJECT_REQUIREMENT_TARGET: '做需求',
      }),
    ).toMatchObject({
      enabled: true,
      owner: 'Acme',
      intervalMs: 120_000,
      routes: [
        { projectNumber: 16, taskType: 'Bug', targetAlias: '修Bug' },
        { projectNumber: 17, taskType: '需求', targetAlias: '做需求' },
      ],
    });
  });

  it('非法数字回退默认值，轮询最短 10 秒', () => {
    expect(
      parseGitHubProjectAutoDispatchConfig({
        GITHUB_PROJECT_POLL_INTERVAL_MS: '1',
        GITHUB_PROJECT_BUG_NUMBER: 'not-number',
      }),
    ).toMatchObject({
      intervalMs: 10_000,
      routes: [{ projectNumber: 6 }, { projectNumber: 7 }],
    });
  });
});
