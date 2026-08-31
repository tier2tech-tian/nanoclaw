import { isQuestionCardAnswerMessage } from './question-card-store.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';
import { messageMatchesTrigger } from './trigger-gate.js';

export function messageMatchesQuestionCardTrigger(
  chatJid: string,
  message: {
    id: string;
    content: string;
    sender: string;
    is_from_me?: boolean;
  },
  allowlist: SenderAllowlistConfig,
): boolean {
  return (
    isQuestionCardAnswerMessage(message.id) ||
    messageMatchesTrigger(chatJid, message, allowlist)
  );
}
