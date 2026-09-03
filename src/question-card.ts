import { escapeCardMarkdownText } from './feishu-card-markdown.js';

export interface QuestionCardOption {
  id: string;
  label: string;
  recommended: boolean;
}

export interface QuestionCardQuestion {
  id: string;
  question: string;
  multi: boolean;
  options: QuestionCardOption[];
}

export interface QuestionCardDraft {
  title: string;
  questions: QuestionCardQuestion[];
}

export type QuestionCardAnswers = Record<string, string[]>;

const MAX_CARD_JSON_BYTES = 29_000;

export interface RawQuestionCardDraft {
  title: string;
  questions: Array<{
    question: string;
    multi?: boolean;
    options: string[];
    recommended?: number[];
  }>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}不能为空`);
  }
  return value.trim();
}

export function normalizeQuestionCardDraft(
  input: RawQuestionCardDraft,
): QuestionCardDraft {
  const title = requiredText(input?.title, '标题');
  if (
    !Array.isArray(input?.questions) ||
    input.questions.length < 1 ||
    input.questions.length > 5
  ) {
    throw new Error('问题数量必须为 1-5 个');
  }

  return {
    title,
    questions: input.questions.map((raw, questionIndex) => {
      const question = requiredText(
        raw?.question,
        `第 ${questionIndex + 1} 题`,
      );
      if (
        !Array.isArray(raw?.options) ||
        raw.options.length < 2 ||
        raw.options.length > 6
      ) {
        throw new Error(`${question}的选项数量必须为 2-6 个`);
      }
      const recommended = [...new Set(raw.recommended ?? [])];
      if (
        recommended.some(
          (index) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= raw.options.length,
        )
      ) {
        throw new Error(`${question}存在无效的推荐索引`);
      }
      if (!raw.multi && recommended.length > 1) {
        throw new Error(`单选题「${question}」最多只能推荐一项`);
      }
      const questionId = `q${questionIndex + 1}`;
      return {
        id: questionId,
        question,
        multi: raw.multi === true,
        options: raw.options.map((label, optionIndex) => ({
          id: `${questionId}o${optionIndex + 1}`,
          label: requiredText(
            label,
            `${question}的第 ${optionIndex + 1} 个选项`,
          ),
          recommended: recommended.includes(optionIndex),
        })),
      };
    }),
  };
}

function optionText(option: QuestionCardOption): string {
  return option.recommended ? `⭐ ${option.label}（推荐）` : option.label;
}

function plainTextInMarkdown(value: string): string {
  return escapeCardMarkdownText(value.replace(/\s+/g, ' ').trim());
}

function baseCard(title: string, elements: unknown[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
    },
    body: { elements },
  };
}

function stringifyCard(card: Record<string, unknown>): string {
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, 'utf8') > MAX_CARD_JSON_BYTES) {
    throw new Error('问题内容超过飞书卡片容量，请缩短后重试');
  }
  return json;
}

export function buildQuestionCardJson(
  cardId: string,
  draft: QuestionCardDraft,
  currentAnswers: QuestionCardAnswers = {},
  revision = 0,
): string {
  if (draft.questions.length === 1 && !draft.questions[0].multi) {
    const question = draft.questions[0];
    return stringifyCard(
      baseCard(draft.title, [
        { tag: 'markdown', content: `**${question.question}**` },
        ...question.options.map((option) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: optionText(option) },
          type: option.recommended ? 'primary' : 'default',
          behaviors: [
            {
              type: 'callback',
              value: {
                action: 'question_card',
                cardId,
                questionId: question.id,
                optionId: option.id,
              },
            },
          ],
        })),
      ]),
    );
  }

  const answers = parseQuestionCardAnswers(draft, currentAnswers);
  const elements: Array<Record<string, unknown>> = [];
  for (const question of draft.questions) {
    elements.push({ tag: 'markdown', content: `**${question.question}**` });
    for (const option of question.options) {
      const selected = (answers[question.id] ?? []).includes(option.id);
      const marker = question.multi
        ? selected
          ? '■'
          : '□'
        : selected
          ? '●'
          : '○';
      elements.push({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: `${marker} ${optionText(option)}`,
        },
        type: 'text',
        behaviors: [
          {
            type: 'callback',
            value: {
              action: 'question_card_select',
              cardId,
              questionId: question.id,
              optionId: option.id,
              selected: question.multi ? !selected : true,
              revision,
            },
          },
        ],
      });
    }
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '提交' },
    type: 'primary',
    disabled: !questionCardAnswersComplete(draft, answers),
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'question_card_submit',
          cardId,
          revision,
        },
      },
    ],
  });

  return stringifyCard(baseCard(draft.title, elements));
}

function assertOption(
  question: QuestionCardQuestion,
  optionId: string,
): string {
  if (!question.options.some((option) => option.id === optionId)) {
    throw new Error(`「${question.question}」包含无效选项`);
  }
  return optionId;
}

export function parseQuestionCardAnswers(
  draft: QuestionCardDraft,
  rawAnswers: unknown,
  requireComplete = false,
): QuestionCardAnswers {
  if (
    !rawAnswers ||
    typeof rawAnswers !== 'object' ||
    Array.isArray(rawAnswers)
  ) {
    if (requireComplete) throw new Error('请完成所有必答题');
    return {};
  }

  const raw = rawAnswers as Record<string, unknown>;
  const answers: QuestionCardAnswers = {};
  for (const question of draft.questions) {
    const selectedRaw = raw[question.id];
    if (selectedRaw === undefined) {
      if (requireComplete) throw new Error(`请回答「${question.question}」`);
      continue;
    }
    if (!Array.isArray(selectedRaw)) {
      throw new Error(`「${question.question}」包含无效选项`);
    }
    const selected = [...new Set(selectedRaw)].map((optionId) => {
      if (typeof optionId !== 'string') {
        throw new Error(`「${question.question}」包含无效选项`);
      }
      return assertOption(question, optionId);
    });
    if (!question.multi && selected.length > 1) {
      throw new Error(`「${question.question}」只能选择一项`);
    }
    if (selected.length === 0) {
      if (requireComplete) throw new Error(`请回答「${question.question}」`);
      continue;
    }
    answers[question.id] = question.options
      .filter((option) => selected.includes(option.id))
      .map((option) => option.id);
  }
  return answers;
}

export function nextQuestionCardAnswers(
  draft: QuestionCardDraft,
  currentAnswers: QuestionCardAnswers,
  questionId: string,
  optionId: string,
): QuestionCardAnswers {
  const answers = parseQuestionCardAnswers(draft, currentAnswers);
  const question = draft.questions.find((item) => item.id === questionId);
  if (!question) throw new Error('无效问题');
  assertOption(question, optionId);

  if (!question.multi) return { ...answers, [questionId]: [optionId] };
  const selected = answers[questionId] ?? [];
  const next = selected.includes(optionId)
    ? selected.filter((id) => id !== optionId)
    : [...selected, optionId];
  if (next.length === 0) {
    const { [questionId]: _, ...rest } = answers;
    return rest;
  }
  return parseQuestionCardAnswers(draft, {
    ...answers,
    [questionId]: next,
  });
}

function questionCardAnswersComplete(
  draft: QuestionCardDraft,
  answers: QuestionCardAnswers,
): boolean {
  return draft.questions.every((question) => answers[question.id]?.length > 0);
}

export function parseQuestionCardSubmission(
  draft: QuestionCardDraft,
  formValue: Record<string, unknown>,
): QuestionCardAnswers {
  const answers: QuestionCardAnswers = {};
  for (const question of draft.questions) {
    let selected: string[];
    if (question.multi) {
      selected = question.options
        .filter((option) => formValue[`${question.id}__${option.id}`] === true)
        .map((option) => option.id);
    } else {
      const raw = formValue[question.id];
      selected =
        typeof raw === 'string' && raw ? [assertOption(question, raw)] : [];
    }
    if (selected.length === 0) {
      throw new Error(`请回答「${question.question}」`);
    }
    answers[question.id] = selected;
  }
  return answers;
}

export function formatQuestionCardAnswer(
  draft: QuestionCardDraft,
  answers: QuestionCardAnswers,
): string {
  const lines = draft.questions.map((question, index) => {
    const labels = (answers[question.id] ?? []).map((optionId) => {
      const option = question.options.find(
        (candidate) => candidate.id === optionId,
      );
      if (!option) throw new Error(`「${question.question}」包含无效选项`);
      return option.label;
    });
    if (labels.length === 0) throw new Error(`请回答「${question.question}」`);
    return `${index + 1}. ${question.question} → ${labels.join('、')}`;
  });
  return `我已回答《${draft.title}》：\n${lines.join('\n')}`;
}

export function buildResolvedQuestionCardJson(
  draft: QuestionCardDraft,
  resolution:
    | { kind: 'answered'; operatorName: string; answers: QuestionCardAnswers }
    | { kind: 'text_replied' },
): string {
  const answered = resolution.kind === 'answered';
  const content = answered
    ? `${resolution.operatorName}已提交\n\n${formatQuestionCardAnswer(
        draft,
        resolution.answers,
      )
        .split('\n')
        .slice(1)
        .join('\n')}`
    : `${draft.questions
        .map(
          (question, questionIndex) =>
            `**${questionIndex + 1}. ${plainTextInMarkdown(question.question)}**\n${question.options
              .map(
                (option, optionIndex) =>
                  `${String.fromCharCode(65 + optionIndex)}. ${plainTextInMarkdown(optionText(option))}`,
              )
              .join('\n')}`,
        )
        .join('\n\n')}\n\n✓ 已通过文字回复`;
  return JSON.stringify({
    schema: '2.0',
    header: {
      template: answered ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content: answered ? `✅ ${draft.title}` : `✓ ${draft.title}`,
      },
    },
    body: { elements: [{ tag: 'markdown', content }] },
  });
}
