import { formatMessages } from './router.js';
import type { NewMessage, PromptImageAttachment } from './types.js';

export interface FormattedAgentInput {
  prompt: string;
  attachments: PromptImageAttachment[];
}

export function formatMessagesForAgent(
  messages: NewMessage[],
  timezone: string,
  nativeImages: boolean,
): FormattedAgentInput {
  if (!nativeImages) {
    return {
      prompt: formatMessages(messages, timezone),
      attachments: [],
    };
  }

  const attachments: PromptImageAttachment[] = [];
  const formattedMessages = messages.map((message, messageIndex) => {
    const messageAttachments = message.attachments ?? [];
    if (messageAttachments.length === 0) return message;

    let content = message.content;
    for (let index = messageAttachments.length - 1; index >= 0; index -= 1) {
      const marker = `[图片: ${messageAttachments[index].path}]`;
      if (content === marker) {
        content = '';
        continue;
      }

      const suffix = `\n${marker}`;
      if (!content.endsWith(suffix)) return message;
      content = content.slice(0, -suffix.length);
    }

    const labels = messageAttachments.map(
      (_, attachmentIndex) =>
        `消息${messageIndex + 1}-图片${attachmentIndex + 1}`,
    );
    messageAttachments.forEach((attachment, attachmentIndex) => {
      attachments.push({
        type: 'image',
        path: attachment.path,
        label: labels[attachmentIndex],
      });
    });

    return {
      ...message,
      content,
    };
  });

  return {
    prompt: formatMessages(formattedMessages, timezone),
    attachments,
  };
}
