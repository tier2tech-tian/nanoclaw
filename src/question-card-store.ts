import { getDb } from './db.js';
import type {
  QuestionCardAnswers,
  QuestionCardDraft,
} from './question-card.js';

export type QuestionCardStatus =
  | 'pending'
  | 'answered'
  | 'text_replied'
  | 'send_failed';

export interface StoredQuestionCard {
  id: string;
  chatJid: string;
  groupFolder: string;
  targetSenderId: string;
  draft: QuestionCardDraft;
  status: QuestionCardStatus;
  messageId?: string;
  resolvedEventId?: string;
  resolvedMessageId?: string;
  operatorId?: string;
  operatorName?: string;
  answers?: QuestionCardAnswers;
  createdAt: string;
  resolvedAt?: string;
}

interface QuestionCardRow {
  id: string;
  chat_jid: string;
  group_folder: string;
  target_sender_id: string;
  draft_json: string;
  status: QuestionCardStatus;
  message_id: string | null;
  resolved_event_id: string | null;
  resolved_message_id: string | null;
  operator_id: string | null;
  operator_name: string | null;
  answers_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

function hydrate(
  row: QuestionCardRow | undefined,
): StoredQuestionCard | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    chatJid: row.chat_jid,
    groupFolder: row.group_folder,
    targetSenderId: row.target_sender_id,
    draft: JSON.parse(row.draft_json) as QuestionCardDraft,
    status: row.status,
    messageId: row.message_id ?? undefined,
    resolvedEventId: row.resolved_event_id ?? undefined,
    resolvedMessageId: row.resolved_message_id ?? undefined,
    operatorId: row.operator_id ?? undefined,
    operatorName: row.operator_name ?? undefined,
    answers: row.answers_json
      ? (JSON.parse(row.answers_json) as QuestionCardAnswers)
      : undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export function createQuestionCard(input: {
  id: string;
  chatJid: string;
  groupFolder: string;
  targetSenderId: string;
  draft: QuestionCardDraft;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO question_cards
       (id, chat_jid, group_folder, target_sender_id, draft_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      input.id,
      input.chatJid,
      input.groupFolder,
      input.targetSenderId,
      JSON.stringify(input.draft),
      input.createdAt,
    );
}

export function attachQuestionCardMessage(
  cardId: string,
  messageId: string,
): void {
  getDb()
    .prepare(`UPDATE question_cards SET message_id = ? WHERE id = ?`)
    .run(messageId, cardId);
}

export function markQuestionCardSendFailed(cardId: string): void {
  getDb()
    .prepare(
      `UPDATE question_cards SET status = 'send_failed' WHERE id = ? AND status = 'pending'`,
    )
    .run(cardId);
}

export function getQuestionCard(
  cardId: string,
): StoredQuestionCard | undefined {
  return hydrate(
    getDb().prepare(`SELECT * FROM question_cards WHERE id = ?`).get(cardId) as
      | QuestionCardRow
      | undefined,
  );
}

export function getQuestionCardByMessageId(
  messageId: string,
): StoredQuestionCard | undefined {
  return hydrate(
    getDb()
      .prepare(`SELECT * FROM question_cards WHERE message_id = ?`)
      .get(messageId) as QuestionCardRow | undefined,
  );
}

export type SubmitQuestionCardResult =
  | { status: 'accepted'; card: StoredQuestionCard }
  | { status: 'already_resolved'; card: StoredQuestionCard }
  | { status: 'unauthorized'; card: StoredQuestionCard }
  | { status: 'not_found' };

export function submitQuestionCardAnswer(input: {
  cardId: string;
  eventId: string;
  operatorId: string;
  operatorName: string;
  answers: QuestionCardAnswers;
  syntheticContent: string;
  timestamp: string;
}): SubmitQuestionCardResult {
  return getDb().transaction((): SubmitQuestionCardResult => {
    const current = getQuestionCard(input.cardId);
    if (!current) return { status: 'not_found' };
    if (current.targetSenderId !== input.operatorId) {
      return { status: 'unauthorized', card: current };
    }
    if (current.status !== 'pending') {
      return { status: 'already_resolved', card: current };
    }

    const update = getDb()
      .prepare(
        `UPDATE question_cards
         SET status = 'answered', resolved_event_id = ?, operator_id = ?,
             operator_name = ?, answers_json = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        input.eventId,
        input.operatorId,
        input.operatorName,
        JSON.stringify(input.answers),
        input.timestamp,
        input.cardId,
      );
    if (update.changes !== 1) {
      const resolved = getQuestionCard(input.cardId);
      if (!resolved) return { status: 'not_found' };
      return { status: 'already_resolved', card: resolved };
    }

    getDb()
      .prepare(
        `INSERT OR IGNORE INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        `question-card:${input.eventId}`,
        current.chatJid,
        input.operatorId,
        input.operatorName,
        input.syntheticContent,
        input.timestamp,
      );
    return { status: 'accepted', card: getQuestionCard(input.cardId)! };
  })();
}

export function resolvePendingQuestionCardByText(input: {
  chatJid: string;
  senderId: string;
  messageId: string;
  timestamp: string;
}): StoredQuestionCard[] {
  return getDb().transaction(() => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM question_cards
         WHERE chat_jid = ? AND target_sender_id = ? AND status = 'pending'
         ORDER BY created_at`,
      )
      .all(input.chatJid, input.senderId) as QuestionCardRow[];
    if (rows.length === 0) return [];
    const update = getDb().prepare(
      `UPDATE question_cards
       SET status = 'text_replied', resolved_message_id = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    const resolved: StoredQuestionCard[] = [];
    for (const row of rows) {
      if (update.run(input.messageId, input.timestamp, row.id).changes === 1) {
        resolved.push(getQuestionCard(row.id)!);
      }
    }
    return resolved;
  })();
}

export function isQuestionCardAnswerMessage(messageId: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM question_cards
         WHERE resolved_message_id = ?
            OR ('question-card:' || resolved_event_id) = ?
         LIMIT 1`,
      )
      .get(messageId, messageId),
  );
}
