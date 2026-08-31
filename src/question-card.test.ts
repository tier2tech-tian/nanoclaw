import { describe, expect, it } from 'vitest';

import {
  buildQuestionCardJson,
  buildResolvedQuestionCardJson,
  formatQuestionCardAnswer,
  normalizeQuestionCardDraft,
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
    const actions = card.body.elements[1].actions;
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('primary');
    expect(actions[0].text.content).toContain('推荐');
    expect(actions[0].value).toBeUndefined();
    expect(actions[0].behaviors[0].value).toMatchObject({
      action: 'question_card',
      cardId: 'card-1',
      questionId: 'q1',
      optionId: 'q1o1',
    });
  });

  it('多题或多选渲染为 form，单选下拉、多选 checker，推荐均不预选', () => {
    const card = JSON.parse(buildQuestionCardJson('card-2', mixedDraft));
    const form = card.body.elements[0];
    expect(form.tag).toBe('form');

    const selector = form.elements.find(
      (element: Record<string, unknown>) => element.tag === 'select_static',
    );
    expect(selector.initial_option).toBeUndefined();
    expect(selector.options[1].text.content).toContain('推荐');

    const checkers = form.elements.filter(
      (element: Record<string, unknown>) => element.tag === 'checker',
    );
    expect(checkers).toHaveLength(3);
    expect(checkers.every((item: { checked: boolean }) => !item.checked)).toBe(
      true,
    );
    expect(checkers[0].text.content).toContain('推荐');

    const submit = form.elements.at(-1);
    expect(submit.form_action_type).toBe('submit');
    expect(submit.behaviors).toBeUndefined();
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
});
