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

export function buildQuestionCardJson(
  cardId: string,
  draft: QuestionCardDraft,
): string {
  if (draft.questions.length === 1 && !draft.questions[0].multi) {
    const question = draft.questions[0];
    return JSON.stringify(
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

  const elements: Array<Record<string, unknown>> = [];
  for (const question of draft.questions) {
    elements.push({ tag: 'markdown', content: `**${question.question}**` });
    if (question.multi) {
      for (const option of question.options) {
        elements.push({
          tag: 'checker',
          name: `${question.id}__${option.id}`,
          checked: false,
          text: { tag: 'plain_text', content: optionText(option) },
        });
      }
    } else {
      elements.push({
        tag: 'select_static',
        name: question.id,
        required: true,
        placeholder: { tag: 'plain_text', content: '请选择' },
        options: question.options.map((option) => ({
          text: { tag: 'plain_text', content: optionText(option) },
          value: option.id,
        })),
      });
    }
  }
  elements.push({
    tag: 'button',
    name: 'submit_question_card',
    text: { tag: 'plain_text', content: '提交' },
    type: 'primary',
    form_action_type: 'submit',
  });

  return JSON.stringify(
    baseCard(draft.title, [{ tag: 'form', name: 'question_card', elements }]),
  );
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
    : '已通过文字回复';
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
