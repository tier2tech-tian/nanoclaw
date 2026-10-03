import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.join(process.cwd(), 'container/skills');
const read = (name: string) =>
  fs.readFileSync(path.join(root, name, 'SKILL.md'), 'utf8');

describe('技能入口契约', () => {
  it('实现兼容入口指向唯一的mp-implement，而非第二套流程', () => {
    expect(read('implement')).toContain('../mp-implement/SKILL.md');
    expect(read('mp-implement')).toContain('name: mp-implement\n');
    expect(read('mp-implement')).toContain('disable-model-invocation: true');
    expect(read('implement')).not.toContain('Step 0');
    expect(read('implement')).not.toContain('不写测试');
    expect(read('ship')).toContain('../mp-implement/SKILL.md');
    expect(read('ship')).not.toContain('跳过所有');
  });

  it('能力查询不依赖容器主群挂载或虚构固定工具', () => {
    expect(read('capabilities')).not.toContain('NOT_MAIN');
    expect(read('capabilities')).not.toContain('/workspace/project');
    expect(read('capabilities')).not.toContain('You always have access');
    expect(read('capabilities')).toContain('实际暴露');
  });

  it('已授权的隔离测试不要求逐条确认', () => {
    expect(read('mp-tdd')).not.toContain('No test is written at an unconfirmed seam');
    expect(read('mp-tdd')).toContain('隔离测试直接执行');
  });

  it('短入口保留飞书环境与身份约束', () => {
    expect(read('lark-cli')).toContain('LARK_CLI_NO_PROXY=1');
    expect(read('lark-cli')).toContain('--as bot');
    expect(read('lark-cli')).toContain('--as user');
    expect(read('lark-cli')).toContain('lark-shared');
  });

  it('精简流程中的本地Markdown指针均存在', () => {
    for (const name of ['implement', 'mp-implement', 'ship', 'capabilities', 'lark-cli']) {
      for (const match of read(name).matchAll(/\]\(([^)]+\.md)\)/g)) {
        expect(fs.existsSync(path.resolve(root, name, match[1])), match[1]).toBe(true);
      }
    }
    const delivery = path.join(root, 'mp-implement/references/delivery.md');
    for (const match of fs.readFileSync(delivery, 'utf8').matchAll(/\]\(([^)]+\.md)\)/g)) {
      expect(fs.existsSync(path.resolve(path.dirname(delivery), match[1])), match[1]).toBe(true);
    }
  });
});
