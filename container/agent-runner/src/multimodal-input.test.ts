import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMultimodalUserContent,
  createMultimodalMessageStream,
} from './multimodal-input.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildMultimodalUserContent', () => {
  it('把校验通过的图片按标签顺序编码为 Claude image block', async () => {
    const root = tempDir();
    const jpg = path.join(root, 'a.jpg');
    const png = path.join(root, 'b.png');
    fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    fs.writeFileSync(
      png,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    );

    const content = await buildMultimodalUserContent(
      '看这两张图',
      [
        { type: 'image', path: jpg, label: '消息1-图片1' },
        { type: 'image', path: png, label: '消息1-图片2' },
      ],
      { allowedRoot: root },
    );

    expect(content).toEqual([
      { type: 'text', text: '看这两张图' },
      { type: 'text', text: '[消息1-图片1]' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64'),
        },
      },
      { type: 'text', text: '[消息1-图片2]' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
          ]).toString('base64'),
        },
      },
    ]);
  });

  it('越界、软链或伪图片只降级为路径文本，不生成 image block', async () => {
    const root = tempDir();
    const outside = path.join(tempDir(), 'outside.jpg');
    const fake = path.join(root, 'fake.jpg');
    const link = path.join(root, 'link.jpg');
    fs.writeFileSync(outside, Buffer.from([0xff, 0xd8, 0xff]));
    fs.writeFileSync(fake, 'not-an-image');
    fs.symlinkSync(outside, link);

    const content = await buildMultimodalUserContent(
      '检查',
      [outside, link, fake].map((file, index) => ({
        type: 'image' as const,
        path: file,
        label: `消息1-图片${index + 1}`,
      })),
      { allowedRoot: root },
    );

    expect(content).toEqual([
      { type: 'text', text: '检查' },
      { type: 'text', text: `[消息1-图片1]\n[图片: ${outside}]` },
      { type: 'text', text: `[消息1-图片2]\n[图片: ${link}]` },
      { type: 'text', text: `[消息1-图片3]\n[图片: ${fake}]` },
    ]);
  });

  it.each([
    ['GIF', Buffer.from('GIF89a!'), 'image/gif'],
    [
      'WebP',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP!'),
      ]),
      'image/webp',
    ],
  ])('识别 %s 文件签名', async (_name, bytes, mediaType) => {
    const root = tempDir();
    const file = path.join(root, 'image.bin');
    fs.writeFileSync(file, bytes as Buffer);

    const content = await buildMultimodalUserContent(
      '看图',
      [{ type: 'image', path: file, label: '消息1-图片1' }],
      { allowedRoot: root },
    );

    expect(content).toMatchObject([
      { type: 'text', text: '看图' },
      { type: 'text', text: '[消息1-图片1]' },
      { type: 'image', source: { media_type: mediaType } },
    ]);
  });

  it('按 base64 估算执行单图、总量和数量预算，超出项逐图降级', async () => {
    const root = tempDir();
    const files = Array.from({ length: 3 }, (_, index) => {
      const file = path.join(root, `${index}.jpg`);
      fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, index]));
      return file;
    });

    const content = await buildMultimodalUserContent(
      '看图',
      files.map((file, index) => ({
        type: 'image' as const,
        path: file,
        label: `消息1-图片${index + 1}`,
      })),
      {
        allowedRoot: root,
        maxImages: 2,
        maxImageBase64Bytes: 8,
        maxTotalBase64Bytes: 8,
      },
    );

    expect(content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'text', text: '[消息1-图片1]' },
      expect.objectContaining({ type: 'image' }),
      { type: 'text', text: `[消息1-图片2]\n[图片: ${files[1]}]` },
      { type: 'text', text: `[消息1-图片3]\n[图片: ${files[2]}]` },
    ]);
  });
});

describe('MessageStream SDK 边界', () => {
  it('假 SDK 消费到的第一帧已经包含图片，不需要第二次请求', async () => {
    const root = tempDir();
    const file = path.join(root, 'first.jpg');
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    const { stream, content } = await createMultimodalMessageStream(
      '看图',
      [{ type: 'image', path: file, label: '消息1-图片1' }],
      { allowedRoot: root },
    );

    const fakeQuery = async (messages: AsyncIterable<unknown>) =>
      (await messages[Symbol.asyncIterator]().next()).value;
    const firstRequest = await fakeQuery(stream);

    expect(firstRequest).toMatchObject({
      type: 'user',
      message: { role: 'user', content },
    });
    expect((firstRequest as any).message.content).toContainEqual(
      expect.objectContaining({ type: 'image' }),
    );
  });
});
