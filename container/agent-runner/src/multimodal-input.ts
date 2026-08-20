import fs from 'fs';
import path from 'path';

import {
  MessageStream,
  type PromptImageAttachment,
  type UserMessageContent,
} from './sdk-message-stream.js';

export interface BuildMultimodalInputOptions {
  allowedRoot: string;
  maxImages?: number;
  maxImageBase64Bytes?: number;
  maxTotalBase64Bytes?: number;
}

export async function buildMultimodalUserContent(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  options: BuildMultimodalInputOptions,
): Promise<UserMessageContent> {
  if (!attachments?.length) return prompt;

  const maxImages = options.maxImages ?? 5;
  const maxImageBase64Bytes = options.maxImageBase64Bytes ?? 5 * 1024 * 1024;
  const maxTotalBase64Bytes = options.maxTotalBase64Bytes ?? 20 * 1024 * 1024;
  const allowedRoot = fs.realpathSync(options.allowedRoot);
  const content: Exclude<UserMessageContent, string> = [
    { type: 'text', text: prompt },
  ];
  let totalBase64Bytes = 0;

  for (const [index, attachment] of attachments.entries()) {
    const fallback = () => {
      content.push({
        type: 'text',
        text: `[${attachment.label}]\n[图片: ${attachment.path}]`,
      });
    };
    if (index >= maxImages) {
      fallback();
      continue;
    }

    let fd: number | undefined;
    try {
      if (fs.lstatSync(attachment.path).isSymbolicLink())
        throw new Error('symlink');
      const realPath = fs.realpathSync(attachment.path);
      const relative = path.relative(allowedRoot, realPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('outside allowed root');
      }

      fd = fs.openSync(
        realPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular file');

      const estimatedBase64Bytes = 4 * Math.ceil(stat.size / 3);
      if (estimatedBase64Bytes > maxImageBase64Bytes) {
        throw new Error('image size exceeded');
      }
      if (totalBase64Bytes + estimatedBase64Bytes > maxTotalBase64Bytes) {
        throw new Error('total size exceeded');
      }

      const data = fs.readFileSync(fd);
      const mediaType = sniffMediaType(data);
      if (!mediaType) throw new Error('unsupported image');

      totalBase64Bytes += estimatedBase64Bytes;
      content.push({ type: 'text', text: `[${attachment.label}]` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: data.toString('base64'),
        },
      });
    } catch {
      fallback();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return content;
}

export async function createMultimodalMessageStream(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  options: BuildMultimodalInputOptions,
): Promise<{ stream: MessageStream; content: UserMessageContent }> {
  const content = await buildMultimodalUserContent(
    prompt,
    attachments,
    options,
  );
  const stream = new MessageStream();
  stream.push(content);
  return { stream, content };
}

function sniffMediaType(
  data: Buffer,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  const prefix = data.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
