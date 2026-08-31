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
const readSkillTree = (name: string): string => {
  const root = path.join(repoRoot, 'container/skills', name);
  const contents: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else contents.push(fs.readFileSync(target, 'utf-8'));
    }
  };
  walk(root);
  return contents.join('\n');
};

describe('GitHub Projects 开发任务生命周期', () => {
  const kickoff = readSkill('kickoff');
  const implement = readSkill('implement');
  const wrapup = readSkill('wrapup');
  const governance = readSkill('github-project-governance');

  it('kickoff 按任务类型和用户显式指定路由项目', () => {
    expect(kickoff).toContain('https://github.com/orgs/TierIITech/projects/9');
    expect(kickoff).toContain('https://github.com/orgs/TierIITech/projects/5');
    expect(kickoff).toContain('https://github.com/orgs/TierIITech/projects/12');
    expect(kickoff).toMatch(/Bug、需求、功能和重构默认进 #9/);
    expect(kickoff).toMatch(/显式指定项目优先/);
    expect(kickoff).toMatch(/项目名.*唯一/);
    expect(kickoff).toMatch(/命中 0 个或多个.*询问/);
    expect(kickoff).toMatch(/不能因为改了前端代码.*推断/);
  });

  it('kickoff 在进入实现前建卡并推进开工态', () => {
    expect(kickoff).toMatch(/轨道 B.*立即执行 3\.5\.1\/3\.5\.2.*3\.5\.3.*B6/);
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
    expect(kickoff).toMatch(/新建.*待办.*准备/);
    expect(kickoff).toContain('github_issue_url');
    expect(kickoff).toContain('github_project_id');
    expect(kickoff).toContain('github_project_item_id');
    expect(kickoff).toContain('驾驶舱');
  });

  it('仓库关闭 Issues 时退化为项目草稿项', () => {
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
    expect(wrapup).toContain('Done');
    expect(wrapup).toContain('完成');
    expect(wrapup).toMatch(/当前状态.*Done.*完成.*跳过/);
  });

  it('三个阶段统一加载治理 skill，禁止旁路高成本命令或内联 GraphQL', () => {
    for (const skill of ['kickoff', 'implement', 'wrapup']) {
      const contents = readSkillTree(skill);
      expect(contents).toContain('github-project-governance');
      expect(contents).not.toMatch(/\bgh\s+project\b/);
      expect(contents).not.toMatch(/\bgh\s+api\s+graphql\b/);
    }
    for (const skill of [kickoff, implement, wrapup]) {
      expect(skill).toContain('github-project-governance');
    }
  });

  it('治理 skill 规定低成本查询、低水位熔断和写后回读', () => {
    expect(governance).toContain('gh api graphql');
    expect(governance).toContain('fieldValueByName');
    expect(governance).toContain('fieldValueByName(name:"环境")');
    expect(governance).toContain('rateLimit');
    expect(governance).toMatch(/remaining.*<=.*100/);
    expect(governance).toContain('addProjectV2ItemById');
    expect(governance).toContain('addProjectV2DraftIssue');
    expect(governance).toContain('updateProjectV2ItemFieldValue');
    const draftMutation = governance
      .split('\n')
      .find((line) => line.includes('addProjectV2DraftIssue'));
    expect(draftMutation).toContain('projectItem');
    expect(draftMutation).not.toContain('projectV2Item');
    expect(governance).toContain('errors');
    expect(governance).toMatch(/回读.*幂等|幂等.*回读/);
    expect(governance).not.toMatch(/fieldValues\s*\(/);
    expect(governance).not.toMatch(/gh project(?:\s|`)/);
    expect(governance).toContain('fields(first:$first,after:$after)');
    expect(governance).toContain('projectsV2(first:$first,after:$after)');
    expect(governance).toContain('pageInfo');
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
