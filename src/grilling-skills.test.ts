import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const skillsRoot = path.join(process.cwd(), 'container', 'skills');

function readSkill(name: string): string {
  return fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
}

describe('grilling skills 的问题卡片契约', () => {
  it('grilling 用一张问题卡承载可枚举的当前决策', () => {
    const content = readSkill('mp-grilling');
    const cardContract = content
      .split('## Ask with question cards')[1]
      .split('For a prose-only round')[0];

    expect(cardContract).toContain('send_question_card');
    expect(cardContract).toContain('1-5 required questions');
    expect(cardContract).toContain('2-6 mutually distinct options');
    expect(cardContract).toContain('single-select or multi-select');
    expect(cardContract).toContain('at least one recommended option');
    expect(cardContract).toContain('without preselecting it');
    expect(cardContract).toContain('end the turn immediately');
    expect(cardContract).toContain('Never repeat the same questions in prose');
    expect(cardContract).toContain(
      'If the tool is unavailable, use the prose-only format instead',
    );
  });

  it('grilling 仅在无法可靠枚举选项时退回文字', () => {
    const content = readSkill('mp-grilling');

    expect(content).toContain(
      'cannot be responsibly expressed as 2-6 options',
    );
    expect(content).toContain('prose-only decisions in their own round');
    expect(content).toContain(
      'If the frontier has more than five bounded decisions',
    );
    expect(content).toContain('first dependency-complete batch');
    expect(content).toContain(
      'then recompute the frontier from the answer before sending any remainder',
    );
  });

  it('grill-with-docs 明确继承 grilling 的发卡契约', () => {
    const content = readSkill('mp-grill-with-docs');

    expect(content).toContain('grilling skill owns the interview');
    expect(content).toContain('question-card contract');
    expect(content).toContain('domain-modeling maintains the ADRs and glossary');
    expect(content).not.toContain('send_question_card');
    expect(content).not.toContain('1-5');
    expect(content).not.toContain('2-6');
  });
});
