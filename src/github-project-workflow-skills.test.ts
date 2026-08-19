import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const readSkill = (name: string) =>
  fs.readFileSync(
    path.join(repoRoot, 'container/skills', name, 'SKILL.md'),
    'utf-8',
  );

describe('GitHub Projects 开发任务生命周期', () => {
  const kickoff = readSkill('kickoff');
  const implement = readSkill('implement');
  const wrapup = readSkill('wrapup');

  it('kickoff 按任务类型和用户显式指定路由项目', () => {
    expect(kickoff).toContain(
      'https://github.com/orgs/TierIITech/projects/6/views/1',
    );
    expect(kickoff).toContain(
      'https://github.com/orgs/TierIITech/projects/7/views/1',
    );
    expect(kickoff).toContain('https://github.com/orgs/TierIITech/projects/5');
    expect(kickoff).toMatch(/Bug.*#6/);
    expect(kickoff).toMatch(/需求.*#7/);
    expect(kickoff).toMatch(/显式指定.*优先/);
    expect(kickoff).toMatch(/项目名.*唯一/);
    expect(kickoff).toMatch(/命中 0 个或多个.*询问/);
    expect(kickoff).toMatch(/不能因为改了前端代码.*推断/);
  });

  it('kickoff 在需求启动时建卡，Bug 则等获准修复后建卡', () => {
    expect(kickoff).toContain('获准实施');
    expect(kickoff).toMatch(/轨道 B.*立即执行 3\.5\.1\/3\.5\.2.*3\.5\.3.*B6/);
    expect(kickoff).toMatch(/Bug.*A3.*获准实施/);
    const bugAuthorization = kickoff.slice(
      kickoff.indexOf('### A3:'),
      kickoff.indexOf('---', kickoff.indexOf('### A3:')),
    );
    expect(bugAuthorization).toContain('Step 3.5.1');
    expect(bugAuthorization).toContain('Step 3.5.2');
    expect(bugAuthorization).toContain('Step 3.5.3');
    const featureAuthorization = kickoff.slice(
      kickoff.indexOf('### B6:'),
      kickoff.indexOf('---', kickoff.indexOf('### B6:')),
    );
    expect(featureAuthorization).toContain('Step 3.5.1');
    expect(featureAuthorization).toContain('Step 3.5.2');
    expect(featureAuthorization).toContain('Step 3.5.3');
    const implementContext = implement.slice(
      implement.indexOf('## Step 0:'),
      implement.indexOf('## Step 1:'),
    );
    expect(implementContext).toContain('Step 3.5.1');
    expect(implementContext).toContain('Step 3.5.2');
    expect(implementContext).toContain('Step 3.5.3');
    expect(kickoff).toMatch(/新建.*Backlog.*准备/);
    expect(kickoff).toContain('hasIssuesEnabled');
    expect(kickoff).toContain('gh project item-list');
    expect(kickoff).toContain('--limit 1000');
    expect(kickoff).toContain('gh issue create');
    expect(kickoff).toContain('gh project item-add');
    expect(kickoff).toContain('In progress');
    expect(kickoff).toContain('进行中');
    expect(kickoff).toContain('github_issue_url');
    expect(kickoff).toContain('github_project_id');
    expect(kickoff).toContain('github_project_item_id');
    expect(kickoff).toContain('驾驶舱');
  });

  it('仓库关闭 Issues 时退化为项目草稿项', () => {
    expect(kickoff).toContain('gh project item-create');
    expect(kickoff).toContain('github_tracking_kind');
    expect(kickoff).toMatch(/Issues.*关闭|关闭.*Issues/);
    expect(kickoff).toMatch(/网络错误、鉴权失败.*不算/);
    expect(implement).toContain('Tracks <项目 URL>');
    expect(implement).toMatch(/draft.*PR URL.*草稿项 body/);
    expect(wrapup).toMatch(/draft.*不执行|草稿.*不执行/);
  });

  it('implement 用关闭关键字绑定 PR，并推进到评审中', () => {
    expect(implement).toContain('github_issue_url');
    expect(implement).toContain('Closes <完整 Issue URL>');
    expect(implement).toContain('gh project item-edit');
    expect(implement).toContain('--single-select-option-id');
    expect(implement).toContain('In review');
    expect(implement).toContain('评审中');
  });

  it('重复执行不会把项目状态倒退', () => {
    expect(kickoff).toMatch(/In review.*Done.*禁止倒退/);
    const startTransition = kickoff.slice(
      kickoff.indexOf('### 3.5.3'),
      kickoff.indexOf('---', kickoff.indexOf('### 3.5.3')),
    );
    expect(startTransition).toMatch(/Gate.*In progress.*In review.*Done/s);
    expect(implement).toMatch(/Done.*完成.*禁止倒退/);
    expect(implement).toContain('github_project_status: <回读到的真实评审态>');
    expect(implement).toMatch(/Gate.*In review.*评审中.*审核中/s);
  });

  it('wrapup 只在合并且验收通过后关闭事项并推进完成态', () => {
    expect(wrapup).toContain('github_project_item_id');
    expect(wrapup).toContain('合并');
    expect(wrapup).toMatch(/E2E|验收/);
    expect(wrapup).toContain('gh issue close');
    expect(wrapup).toContain('gh project item-edit');
    expect(wrapup).toContain('Done');
    expect(wrapup).toContain('完成');
    expect(wrapup).toMatch(/当前状态.*Done.*完成.*跳过/);
  });

  it('三个阶段复用同一个项目 Item，并在项目收口后才标群完成', () => {
    for (const skill of [kickoff, implement, wrapup]) {
      expect(skill).toContain('github_project_item_id');
    }

    const closeProjectAt = wrapup.indexOf('### Step 0.5: 关闭 GitHub 跟踪项');
    const writeWikiAt = wrapup.indexOf('### Step 4: 存入团队知识库');
    const renameDoneAt = wrapup.indexOf('调用 `rename_chat` 将群名改为');
    expect(closeProjectAt).toBeGreaterThan(-1);
    expect(closeProjectAt).toBeLessThan(writeWikiAt);
    expect(renameDoneAt).toBeGreaterThan(closeProjectAt);
  });
});
