import { describe, expect, it, vi } from 'vitest';

import { buildProgressFixtureSnapshotForTest } from './channels/feishu.js';
import {
  createProgressPresentationState,
  reduceProgressPresentation,
} from './progress-display.js';

describe('buildProgressFixtureSnapshotForTest', () => {
  it('导出完整、确定性的可见窗口和卡片 JSON', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T04:00:00.000Z'));
    try {
      let state = createProgressPresentationState();
      state = reduceProgressPresentation(state, {
        kind: 'narration',
        text: '核对过程卡片。',
      });
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: {
          provider: 'codex',
          lifecycle: 'started',
          toolName: 'Read',
          toolCallId: 'read-1',
          input: { file_path: 'src/index.ts' },
        },
      });

      const snapshot = buildProgressFixtureSnapshotForTest(state, {
        frame: 0,
        startTime: Date.now() - 2_000,
      });

      expect(snapshot.visibleSteps).toHaveLength(1);
      expect(snapshot.visibleSteps[0]).toMatchObject({
        title: '核对过程卡片。',
        grayTail: '正在读取 src/index.ts',
        narrationFull: '核对过程卡片。',
        presentationId: 'phase-1',
        ts: Date.now(),
      });
      expect(snapshot.card).toMatchObject({
        schema: '2.0',
        config: { update_multi: true },
        body: {
          elements: [
            { tag: 'markdown' },
            { tag: 'hr' },
            {
              tag: 'collapsible_panel',
              expanded: false,
              header: { title: { tag: 'markdown' } },
            },
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
