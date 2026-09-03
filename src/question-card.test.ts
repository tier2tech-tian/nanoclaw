import { describe, expect, it } from 'vitest';

import {
  buildQuestionCardJson,
  buildResolvedQuestionCardJson,
  formatQuestionCardAnswer,
  nextQuestionCardAnswers,
  normalizeQuestionCardDraft,
  parseQuestionCardAnswers,
  parseQuestionCardSubmission,
} from './question-card.js';

const mixedDraft = normalizeQuestionCardDraft({
  title: '发布确认',
  questions: [
    {
      question: '发布时间怎么选？',
      multi: false,
      options: ['立即发布', '低峰发布', '明天发布'],
      recommended: [1],
    },
    {
      question: '需要同步谁？',
      multi: true,
      options: ['研发', 'QA', '产品'],
      recommended: [0, 1],
    },
  ],
});

describe('问题表单卡片契约', () => {
  it('限制 1-5 题、每题 2-6 个选项，并校验推荐索引', () => {
    expect(() =>
      normalizeQuestionCardDraft({ title: '空', questions: [] }),
    ).toThrow(/1-5/);
    expect(() =>
      normalizeQuestionCardDraft({
        title: '越界',
        questions: [
          {
            question: '选一个',
            multi: false,
            options: ['A', 'B'],
            recommended: [2],
          },
        ],
      }),
    ).toThrow(/推荐索引/);
    expect(() =>
      normalizeQuestionCardDraft({
        title: '单选多推荐',
        questions: [
          {
            question: '选一个',
            multi: false,
            options: ['A', 'B'],
            recommended: [0, 1],
          },
        ],
      }),
    ).toThrow(/单选题/);
  });

  it('单题单选渲染为即时按钮，推荐项只高亮不预选', () => {
    const draft = normalizeQuestionCardDraft({
      title: '选择环境',
      questions: [
        {
          question: '部署到哪里？',
          multi: false,
          options: ['DEV', 'PROD'],
          recommended: [0],
        },
      ],
    });

    const card = JSON.parse(buildQuestionCardJson('card-1', draft));
    const buttons = card.body.elements.slice(1);
    expect(buttons).toHaveLength(2);
    expect(
      buttons.every((item: { tag: string }) => item.tag === 'button'),
    ).toBe(true);
    expect(
      card.body.elements.some((item: { tag: string }) => item.tag === 'action'),
    ).toBe(false);
    expect(buttons[0].type).toBe('primary');
    expect(buttons[0].text.content).toContain('推荐');
    expect(buttons[0].value).toBeUndefined();
    expect(buttons[0].behaviors[0].value).toMatchObject({
      action: 'question_card',
      cardId: 'card-1',
      questionId: 'q1',
      optionId: 'q1o1',
    });
  });

  it('多题或多选渲染为无边框选项，初始不预选且不能提交', () => {
    const card = JSON.parse(buildQuestionCardJson('card-2', mixedDraft));
    const buttons = card.body.elements.filter(
      (element: Record<string, unknown>) => element.tag === 'button',
    );
    expect(buttons).toHaveLength(7);
    expect(
      buttons.slice(0, -1).every((item: any) => item.type === 'text'),
    ).toBe(true);
    expect(buttons[0].text.content).toBe('○ 立即发布');
    expect(buttons[1].text.content).toContain('○ ⭐ 低峰发布（推荐）');
    expect(buttons[3].text.content).toContain('□ ⭐ 研发（推荐）');
    expect(buttons[0].behaviors[0].value.selected).toBe(true);
    expect(JSON.stringify(card)).not.toContain('select_static');
    expect(JSON.stringify(card)).not.toContain('checker');
    expect(JSON.stringify(card)).not.toContain('"tag":"form"');

    const submit = buttons.at(-1);
    expect(submit.type).toBe('primary');
    expect(submit.disabled).toBe(true);
    expect(submit.behaviors[0].value).toMatchObject({
      action: 'question_card_submit',
      cardId: 'card-2',
      revision: 0,
    });
    expect(submit.behaviors[0].value.answers).toBeUndefined();
  });

  it('选中态显示圆点和方框，答完所有题后启用统一提交', () => {
    const answers = { q1: ['q1o2'], q2: ['q2o1', 'q2o3'] };
    const card = JSON.parse(
      buildQuestionCardJson('card-2', mixedDraft, answers, 3),
    );
    const buttons = card.body.elements.filter(
      (element: Record<string, unknown>) => element.tag === 'button',
    );

    expect(buttons[0].text.content).toBe('○ 立即发布');
    expect(buttons[1].text.content).toContain('● ⭐ 低峰发布（推荐）');
    expect(buttons[3].text.content).toContain('■ ⭐ 研发（推荐）');
    expect(buttons[1].behaviors[0].value.selected).toBe(true);
    expect(buttons[3].behaviors[0].value.selected).toBe(false);
    expect(buttons[4].text.content).toContain('□ ⭐ QA（推荐）');
    expect(buttons[5].text.content).toBe('■ 产品');
    expect(buttons.at(-1).disabled).toBe(false);
    expect(buttons.at(-1).behaviors[0].value).toMatchObject({
      action: 'question_card_submit',
      revision: 3,
    });
    expect(buttons.at(-1).behaviors[0].value.answers).toBeUndefined();
  });

  it('单选会替换旧值，多选会逐项切换', () => {
    expect(nextQuestionCardAnswers(mixedDraft, {}, 'q1', 'q1o2')).toEqual({
      q1: ['q1o2'],
    });
    expect(
      nextQuestionCardAnswers(
        mixedDraft,
        { q1: ['q1o2'], q2: ['q2o1'] },
        'q1',
        'q1o3',
      ),
    ).toEqual({ q1: ['q1o3'], q2: ['q2o1'] });
    expect(
      nextQuestionCardAnswers(
        mixedDraft,
        { q1: ['q1o2'], q2: ['q2o1'] },
        'q2',
        'q2o3',
      ),
    ).toEqual({ q1: ['q1o2'], q2: ['q2o1', 'q2o3'] });
    expect(
      nextQuestionCardAnswers(
        mixedDraft,
        { q1: ['q1o2'], q2: ['q2o1', 'q2o3'] },
        'q2',
        'q2o1',
      ),
    ).toEqual({ q1: ['q1o2'], q2: ['q2o3'] });
  });

  it('状态答案拒绝伪造选项，提交时要求所有题必答', () => {
    expect(parseQuestionCardAnswers(mixedDraft, { q1: ['q1o2'] })).toEqual({
      q1: ['q1o2'],
    });
    expect(() =>
      parseQuestionCardAnswers(mixedDraft, { q1: ['fake'] }),
    ).toThrow(/无效选项/);
    expect(() =>
      parseQuestionCardAnswers(mixedDraft, { q1: ['q1o2'] }, true),
    ).toThrow(/需要同步谁/);
  });

  it('卡片超过飞书容量时明确拒绝，不发送残缺内容', () => {
    const oversized = normalizeQuestionCardDraft({
      title: '超长卡片',
      questions: [
        {
          question: '请选择',
          options: Array.from(
            { length: 6 },
            (_, index) => `${index}-${'长'.repeat(5_000)}`,
          ),
        },
      ],
    });
    expect(() => buildQuestionCardJson('card-large', oversized)).toThrow(
      /超过飞书卡片容量/,
    );
  });

  it('解析完整表单答案，缺少必答题时拒绝', () => {
    expect(
      parseQuestionCardSubmission(mixedDraft, {
        q1: 'q1o2',
        q2__q2o1: true,
        q2__q2o3: true,
      }),
    ).toEqual({ q1: ['q1o2'], q2: ['q2o1', 'q2o3'] });

    expect(() =>
      parseQuestionCardSubmission(mixedDraft, {
        q1: 'q1o2',
      }),
    ).toThrow(/需要同步谁/);
  });

  it('生成模型可读的完整答案和无按钮终态卡片', () => {
    const answers = { q1: ['q1o2'], q2: ['q2o1', 'q2o3'] };
    const text = formatQuestionCardAnswer(mixedDraft, answers);
    expect(text).toContain('我已回答《发布确认》');
    expect(text).toContain('发布时间怎么选？ → 低峰发布');
    expect(text).toContain('需要同步谁？ → 研发、产品');

    const card = JSON.parse(
      buildResolvedQuestionCardJson(mixedDraft, {
        kind: 'answered',
        operatorName: '大杰',
        answers,
      }),
    );
    expect(JSON.stringify(card)).toContain('大杰已提交');
    expect(JSON.stringify(card)).not.toContain('button');
    expect(JSON.stringify(card)).not.toContain('checker');
    expect(JSON.stringify(card)).not.toContain('select_static');
  });

  it('文字回复终态卡保留原问题和纯文字选项', () => {
    const card = JSON.parse(
      buildResolvedQuestionCardJson(mixedDraft, { kind: 'text_replied' }),
    );
    const serialized = JSON.stringify(card);
    const content = card.body.elements[0].content;

    expect(content).toContain('1. 发布时间怎么选？');
    expect(content).toContain('A. 立即发布');
    expect(content).toContain('B. ⭐ 低峰发布（推荐）');
    expect(content).toContain('2. 需要同步谁？');
    expect(content).toContain('A. ⭐ 研发（推荐）');
    expect(content).toContain('B. ⭐ QA（推荐）');
    expect(content).toContain('C. 产品');
    expect(content.endsWith('✓ 已通过文字回复')).toBe(true);
    for (const tag of ['button', 'checker', 'select_static', 'form', 'action']) {
      expect(serialized).not.toContain(`"tag":"${tag}"`);
    }
    expect(serialized).not.toContain('behaviors');
  });

  it('文字回复终态把问题和选项按纯文字转义并压平换行', () => {
    const draft = normalizeQuestionCardDraft({
      title: '特殊字符',
      questions: [
        {
          question:
            '是否采用 [方案](https://example.com) **重点**？<at id=all> ~删除~ &',
          options: ['第一行\nB. 伪选项', '`代码` 与 *强调*'],
        },
      ],
    });
    const card = JSON.parse(
      buildResolvedQuestionCardJson(draft, { kind: 'text_replied' }),
    );
    const content = card.body.elements[0].content;

    expect(content).toContain(
      '是否采用 &#91;方案&#93;&#40;https&#58;&#47;&#47;example&#46;com&#41; ' +
        '&#42;&#42;重点&#42;&#42;？&lt;at id=all&gt; &#126;删除&#126; &amp;',
    );
    expect(content).toContain('A. 第一行 B&#46; 伪选项');
    expect(content).toContain('B. &#96;代码&#96; 与 &#42;强调&#42;');
    expect(content.endsWith('✓ 已通过文字回复')).toBe(true);
  });
});
