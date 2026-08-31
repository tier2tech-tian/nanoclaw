import { isQuestionCardAnswerMessage } from './question-card-store.js';

export function messageMatchesQuestionCardTrigger(
  messageId: string,
  matchesNormalTrigger: boolean,
): boolean {
  return isQuestionCardAnswerMessage(messageId) || matchesNormalTrigger;
}
