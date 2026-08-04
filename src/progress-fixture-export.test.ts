import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

  it('fixture 锁定完整卡片结构和全部 cases 的摘要', () => {
    const fixture = JSON.parse(
      readFileSync('test-fixtures/progress-card-v2.json', 'utf8'),
    ) as {
      schema: string;
      behaviorCommit: string;
      exporterCommit: string;
      casesSha256: string;
      normalization: { deletedJsonPointers: string[] };
      cases: Array<{
        snapshots: Array<{
          card: {
            schema: string;
            config: { update_multi: boolean };
            body: { elements: unknown[] };
          };
        }>;
      }>;
    };

    expect(fixture.schema).toBe('nanoclaw-progress-card-fixture/v2');
    expect(fixture.behaviorCommit).toBe(
      '426b64dda3635995f1cc47ec330fa20392c17944',
    );
    expect(fixture.exporterCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(fixture.normalization.deletedJsonPointers).toEqual([]);
    expect(fixture.cases).toHaveLength(15);
    expect(
      createHash('sha256').update(JSON.stringify(fixture.cases)).digest('hex'),
    ).toBe(fixture.casesSha256);
    for (const fixtureCase of fixture.cases) {
      for (const snapshot of fixtureCase.snapshots) {
        expect(snapshot.card.schema).toBe('2.0');
        expect(snapshot.card.config.update_multi).toBe(true);
        expect(Array.isArray(snapshot.card.body.elements)).toBe(true);
      }
    }
  });
});
