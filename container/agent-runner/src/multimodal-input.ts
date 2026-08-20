import { execFileSync } from 'child_process';
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

export type ImageDiagnosticReason =
  | 'missing'
  | 'outside_root'
  | 'symlink'
  | 'path_changed'
  | 'not_file'
  | 'unsupported'
  | 'image_limit'
  | 'image_size'
  | 'total_size'
  | 'io_error';

export interface MultimodalDiagnostics {
  native: number;
  fallback: number;
  skipped: number;
  reasons: Partial<Record<ImageDiagnosticReason, number>>;
}

export interface BuiltMultimodalContent {
  content: UserMessageContent;
  diagnostics: MultimodalDiagnostics;
}

export async function buildMultimodalUserContent(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  options: BuildMultimodalInputOptions,
): Promise<UserMessageContent> {
  return (
    await buildMultimodalUserContentWithDiagnostics(
      prompt,
      attachments,
      options,
    )
  ).content;
}

export async function buildMultimodalUserContentWithDiagnostics(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  options: BuildMultimodalInputOptions,
): Promise<BuiltMultimodalContent> {
  const diagnostics: MultimodalDiagnostics = {
    native: 0,
    fallback: 0,
    skipped: 0,
    reasons: {},
  };
  if (!attachments?.length) return { content: prompt, diagnostics };

  const maxImages = options.maxImages ?? 5;
  const maxImageBase64Bytes = options.maxImageBase64Bytes ?? 5 * 1024 * 1024;
  const maxTotalBase64Bytes = options.maxTotalBase64Bytes ?? 20 * 1024 * 1024;
  const allowedLexicalRoot = path.resolve(options.allowedRoot);
  const allowedRoot = fs.realpathSync(options.allowedRoot);
  const content: Exclude<UserMessageContent, string> = [
    { type: 'text', text: prompt },
  ];
  let totalBase64Bytes = 0;
  let nativeCount = 0;

  for (const attachment of attachments) {
    const reject = (reason: ImageDiagnosticReason, exposePath: boolean) => {
      diagnostics.reasons[reason] = (diagnostics.reasons[reason] ?? 0) + 1;
      if (exposePath) {
        diagnostics.fallback += 1;
      } else {
        diagnostics.skipped += 1;
      }
      content.push({
        type: 'text',
        text: exposePath
          ? `[${attachment.label}]\n[图片: ${attachment.path}]`
          : `[${attachment.label}]\n[图片不可用: ${reason}]`,
      });
    };
    if (nativeCount >= maxImages) {
      reject('image_limit', true);
      continue;
    }

    let fd: number | undefined;
    try {
      const lexicalPath = path.resolve(attachment.path);
      if (!isWithinRoot(allowedLexicalRoot, lexicalPath)) {
        reject('outside_root', false);
        continue;
      }
      const pathCheck = checkPathComponents(allowedLexicalRoot, lexicalPath);
      if (pathCheck === 'symlink') {
        reject('symlink', false);
        continue;
      }
      if (pathCheck === 'missing') {
        reject('missing', true);
        continue;
      }

      const realPath = fs.realpathSync(attachment.path);
      if (!isWithinRoot(allowedRoot, realPath)) {
        reject('outside_root', false);
        continue;
      }

      const expected = fs.statSync(realPath);
      fd = fs.openSync(
        realPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const stat = fs.fstatSync(fd);
      if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
        reject('path_changed', false);
        continue;
      }
      const openedPath = resolveOpenedFilePath(fd);
      if (!openedPath || !isWithinRoot(allowedRoot, openedPath)) {
        reject('path_changed', false);
        continue;
      }
      if (!stat.isFile()) {
        reject('not_file', true);
        continue;
      }

      const estimatedBase64Bytes = 4 * Math.ceil(stat.size / 3);
      if (estimatedBase64Bytes > maxImageBase64Bytes) {
        reject('image_size', true);
        continue;
      }
      if (totalBase64Bytes + estimatedBase64Bytes > maxTotalBase64Bytes) {
        reject('total_size', true);
        continue;
      }

      const remainingBase64Bytes = Math.min(
        maxImageBase64Bytes,
        maxTotalBase64Bytes - totalBase64Bytes,
      );
      const rawLimit = maxRawBytesForBase64(remainingBase64Bytes);
      const data = readBounded(fd, rawLimit);
      if (!data) {
        reject(
          remainingBase64Bytes === maxImageBase64Bytes
            ? 'image_size'
            : 'total_size',
          true,
        );
        continue;
      }
      const actualBase64Bytes = 4 * Math.ceil(data.length / 3);
      const mediaType = sniffMediaType(data);
      if (!mediaType) {
        reject('unsupported', true);
        continue;
      }

      totalBase64Bytes += actualBase64Bytes;
      nativeCount += 1;
      diagnostics.native += 1;
      content.push({ type: 'text', text: `[${attachment.label}]` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: data.toString('base64'),
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === 'ENOENT' ? 'missing' : 'io_error', code === 'ENOENT');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return { content, diagnostics };
}

export async function createMultimodalMessageStream(
  prompt: string,
  attachments: PromptImageAttachment[] | undefined,
  options: BuildMultimodalInputOptions,
): Promise<{
  stream: MessageStream;
  content: UserMessageContent;
  diagnostics: MultimodalDiagnostics;
}> {
  const { content, diagnostics } =
    await buildMultimodalUserContentWithDiagnostics(
      prompt,
      attachments,
      options,
    );
  const stream = new MessageStream();
  stream.push(content);
  return { stream, content, diagnostics };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function checkPathComponents(
  root: string,
  candidate: string,
): 'ok' | 'missing' | 'symlink' {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return 'symlink';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }
  return 'ok';
}

function maxRawBytesForBase64(maxBase64Bytes: number): number {
  let rawBytes = Math.floor(maxBase64Bytes / 4) * 3;
  while (rawBytes > 0 && 4 * Math.ceil(rawBytes / 3) > maxBase64Bytes) {
    rawBytes -= 1;
  }
  return rawBytes;
}

function readBounded(fd: number, maxBytes: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) return null;
  return buffer.subarray(0, offset);
}

function resolveOpenedFilePath(fd: number): string | null {
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    // macOS 没有 /proc；lsof 从内核中的已打开 fd 取路径，避免再次解析可变路径。
  }

  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(process.pid), '-d', String(fd), '-Fn'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const name = output
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    return name ? fs.realpathSync(name) : null;
  } catch {
    return null;
  }
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
