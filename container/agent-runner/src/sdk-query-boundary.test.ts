import { describe, expect, it, vi } from 'vitest';

import { invokeClaudeQuery } from './sdk-query-boundary.js';
import { MessageStream } from './sdk-message-stream.js';

describe('invokeClaudeQuery', () => {
  it('把同一个 MessageStream 作为 query prompt，第一帧保留 image block', async () => {
    const stream = new MessageStream();
    stream.push([
      { type: 'text', text: '看图' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: '/9j/',
        },
      },
    ]);
    const queryFn = vi.fn(({ prompt }: { prompt: MessageStream; options: { model: string } }) => prompt);

    const received = invokeClaudeQuery(queryFn, stream, {
      model: 'test-model',
    });
    const first = await received[Symbol.asyncIterator]().next();

    expect(queryFn).toHaveBeenCalledOnce();
    expect(queryFn.mock.calls[0][0].prompt).toBe(stream);
    expect(first.value.message.content).toContainEqual(expect.objectContaining({ type: 'image' }));
  });
});
