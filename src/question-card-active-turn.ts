import type { QuestionCardDraft } from './question-card.js';

export interface ActiveQuestionCardTurn {
  sendQuestionCard: (
    groupFolder: string,
    draft: QuestionCardDraft,
  ) => Promise<string>;
}

export function createActiveQuestionCardTurn(
  send: (groupFolder: string, draft: QuestionCardDraft) => Promise<string>,
): ActiveQuestionCardTurn {
  const turn: ActiveQuestionCardTurn = {
    sendQuestionCard: (groupFolder, draft) => send(groupFolder, draft),
  };
  return turn;
}

// 输出归属跟随进程生命周期，不能因固定超时而漏记已发送的卡片。
export async function withActiveQuestionCardTurn<T>(
  turns: Map<string, ActiveQuestionCardTurn>,
  chatJid: string,
  turn: ActiveQuestionCardTurn,
  run: () => Promise<T>,
): Promise<T> {
  turns.set(chatJid, turn);
  try {
    return await run();
  } finally {
    if (turns.get(chatJid) === turn) turns.delete(chatJid);
  }
}

// 无活跃进程记录时，仍可向已授权会话发卡。
export function sendQuestionCardForTurn(
  activeTurn: ActiveQuestionCardTurn | undefined,
  groupFolder: string,
  draft: QuestionCardDraft,
  fallbackSend: ActiveQuestionCardTurn['sendQuestionCard'],
): Promise<string> {
  return (activeTurn?.sendQuestionCard ?? fallbackSend)(groupFolder, draft);
}
