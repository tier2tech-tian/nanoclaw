import type { PromptImageAttachment } from './sdk-message-stream.js';
import type {
  BuildMultimodalInputOptions,
  MultimodalDiagnostics,
} from './multimodal-input.js';
import { buildMultimodalUserContentWithDiagnostics } from './multimodal-input.js';
import type { UserMessageContent } from './sdk-message-stream.js';

export interface BatchableIpcMessage {
  text: string;
  attachments?: PromptImageAttachment[];
  messageCount?: number;
  senderId?: string;
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' };
  context?: unknown;
}

export interface MergedIpcMessage extends BatchableIpcMessage {
  attachments: PromptImageAttachment[];
}

interface ContentSink {
  push(content: UserMessageContent): void;
}

export function mergeIpcMessages(
  messages: BatchableIpcMessage[],
): MergedIpcMessage {
  const last = messages[messages.length - 1];
  const attachments: PromptImageAttachment[] = [];
  let messageOffset = 0;

  for (const message of messages) {
    const imageCounts = new Map<number, number>();
    const parsedMessageNumbers = (message.attachments ?? [])
      .map((attachment) => /^消息(\d+)-图片\d+$/.exec(attachment.label))
      .map((match) => (match ? Number(match[1]) : 1));
    const sourceMessageCount = Math.max(
      1,
      normalizeMessageCount(message.messageCount),
      ...parsedMessageNumbers,
    );

    for (const attachment of message.attachments ?? []) {
      const match = /^消息(\d+)-图片(\d+)$/.exec(attachment.label);
      const sourceMessageNumber = match ? Number(match[1]) : 1;
      const messageNumber = messageOffset + sourceMessageNumber;
      const imageNumber = (imageCounts.get(messageNumber) ?? 0) + 1;
      imageCounts.set(messageNumber, imageNumber);
      attachments.push({
        ...attachment,
        label: `消息${messageNumber}-图片${imageNumber}`,
      });
    }
    messageOffset += sourceMessageCount;
  }

  return {
    text: messages.map((message) => message.text).join('\n'),
    attachments,
    messageCount: messageOffset,
    senderId: last?.senderId,
    modelOverride: last?.modelOverride,
    context: last?.context,
  };
}

export function mergeInitialPromptWithPending(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  pending: BatchableIpcMessage[],
  messageCount = 1,
): MergedIpcMessage {
  return mergeIpcMessages([
    { text: prompt, attachments, messageCount },
    ...pending,
  ]);
}

export async function pushMergedIpcMessage(
  sink: ContentSink,
  message: MergedIpcMessage,
  options: BuildMultimodalInputOptions,
): Promise<MultimodalDiagnostics> {
  const built = await buildMultimodalUserContentWithDiagnostics(
    message.text,
    message.attachments,
    options,
  );
  sink.push(built.content);
  return built.diagnostics;
}

function normalizeMessageCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 1;
}
