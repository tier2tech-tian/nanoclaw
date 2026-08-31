import {
  normalizeQuestionCardDraft,
  type QuestionCardDraft,
} from './question-card.js';

const QUESTION_CARD_TOOL = 'mcp__nanoclaw__send_question_card';
const AUTHORIZATION_TTL_MS = 30_000;

interface QuestionCardAuthorization {
  chatJid: string;
  fingerprint: string;
  toolCallId?: string;
  expiresAt: number;
}

const pendingAuthorizations = new Map<string, QuestionCardAuthorization[]>();

function fingerprint(draft: QuestionCardDraft): string {
  return JSON.stringify(draft);
}

export function observeQuestionCardToolUse(
  sessionFolder: string,
  chatJid: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
  toolCallId?: string,
): boolean {
  if (toolName !== QUESTION_CARD_TOOL || !input) return false;
  const draft = normalizeQuestionCardDraft(input as any);
  const now = Date.now();
  const active = (pendingAuthorizations.get(sessionFolder) ?? []).filter(
    (item) => item.expiresAt > now,
  );
  const draftFingerprint = fingerprint(draft);
  if (
    active.some((item) =>
      toolCallId
        ? item.toolCallId === toolCallId
        : item.chatJid === chatJid && item.fingerprint === draftFingerprint,
    )
  ) {
    pendingAuthorizations.set(sessionFolder, active);
    return true;
  }
  active.push({
    chatJid,
    fingerprint: draftFingerprint,
    toolCallId,
    expiresAt: now + AUTHORIZATION_TTL_MS,
  });
  pendingAuthorizations.set(sessionFolder, active);
  return true;
}

export function consumeQuestionCardAuthorization(
  sessionFolder: string,
  chatJid: string,
  draft: QuestionCardDraft,
): boolean {
  const now = Date.now();
  const expectedFingerprint = fingerprint(draft);
  const active = (pendingAuthorizations.get(sessionFolder) ?? []).filter(
    (item) => item.expiresAt > now,
  );
  const index = active.findIndex(
    (item) =>
      item.chatJid === chatJid && item.fingerprint === expectedFingerprint,
  );
  if (index < 0) {
    if (active.length > 0) pendingAuthorizations.set(sessionFolder, active);
    else pendingAuthorizations.delete(sessionFolder);
    return false;
  }
  active.splice(index, 1);
  if (active.length > 0) pendingAuthorizations.set(sessionFolder, active);
  else pendingAuthorizations.delete(sessionFolder);
  return true;
}
