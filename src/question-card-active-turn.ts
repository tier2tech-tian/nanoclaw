import type { QuestionCardDraft } from './question-card.js';

export interface ActiveQuestionCardTurn {
  senderId: string;
  sendQuestionCard: (
    groupFolder: string,
    draft: QuestionCardDraft,
  ) => Promise<string>;
}

export function createActiveQuestionCardTurn(
  initialSenderId: string,
  send: (
    groupFolder: string,
    targetSenderId: string,
    draft: QuestionCardDraft,
  ) => Promise<string>,
): ActiveQuestionCardTurn {
  const turn: ActiveQuestionCardTurn = {
    senderId: initialSenderId,
    sendQuestionCard: (groupFolder, draft) =>
      send(groupFolder, turn.senderId, draft),
  };
  return turn;
}
