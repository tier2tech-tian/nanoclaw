import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildProgressFixtureSnapshotForTest } from '../src/channels/feishu.js';
import {
  classifyProgressAction,
  createProgressPresentationState,
  reduceProgressPresentation,
  type ProgressPresentationEvent,
  type StructuredProgress,
} from '../src/progress-display.js';

const BEHAVIOR_COMMIT = '426b64dda3635995f1cc47ec330fa20392c17944';
const FIXED_NOW = Date.parse('2026-07-24T04:00:00.000Z');
const OUTPUT = resolve('test-fixtures/progress-card-v2.json');

function tool(
  lifecycle: StructuredProgress['lifecycle'],
  toolName: string,
  toolCallId: string,
  input?: Record<string, unknown>,
  extra: Partial<StructuredProgress> = {},
): ProgressPresentationEvent {
  return {
    kind: 'tool',
    progress: {
      provider: 'codex',
      lifecycle,
      toolName,
      toolCallId,
      ...(input ? { input } : {}),
      ...extra,
    },
  };
}

const cases: Array<{ name: string; events: ProgressPresentationEvent[] }> = [
  {
    name: 'consecutive_narration_merges',
    events: [
      { kind: 'narration', text: '先检查配置。' },
      { kind: 'narration', text: '再确认调用链。' },
    ],
  },
  {
    name: 'fallback_upgrades_latest_to_narration',
    events: [
      tool('started', 'Read', 'read-1', { file_path: 'src/a.ts' }),
      tool('completed', 'Read', 'read-1'),
      tool('started', 'Grep', 'grep-1', { pattern: 'needle' }),
      { kind: 'narration', text: '核对搜索结果。' },
    ],
  },
  {
    name: 'four_fallback_actions_roll_to_latest_three',
    events: [
      tool('started', 'Read', 'read-1', { file_path: 'src/a.ts' }),
      tool('completed', 'Read', 'read-1'),
      tool('started', 'Grep', 'grep-1', { pattern: 'needle' }),
      tool('completed', 'Grep', 'grep-1'),
      tool('started', 'Write', 'write-1', { file_path: 'src/b.ts' }),
      tool('completed', 'Write', 'write-1'),
      tool('started', 'Bash', 'test-1', { command: 'npm test' }),
    ],
  },
  {
    name: 'narration_tool_narration_creates_two_phases',
    events: [
      { kind: 'narration', text: '检查实现。' },
      tool('started', 'Grep', 'grep-1', { pattern: 'FrameTranslator' }),
      tool('completed', 'Grep', 'grep-1'),
      { kind: 'narration', text: '补齐测试。' },
    ],
  },
  {
    name: 'parallel_same_tool_completes_in_reverse_order',
    events: [
      { kind: 'narration', text: '并行核查两个文件。' },
      tool('started', 'Read', 'read-a', { file_path: 'src/a.ts' }),
      tool('started', 'Read', 'read-b', { file_path: 'src/b.ts' }),
      tool('completed', 'Read', 'read-b'),
      tool('completed', 'Read', 'read-a'),
    ],
  },
  {
    name: 'duplicate_started_enriches_in_place',
    events: [
      tool('started', 'Bash', 'bash-1', { command: 'rg' }),
      tool('started', 'Bash', 'bash-1', { command: 'rg target src' }),
      tool('completed', 'Bash', 'bash-1'),
    ],
  },
  {
    name: 'apply_patch_single_multi_and_sensitive_targets',
    events: [
      tool('started', 'Bash', 'patch-1', {
        command:
          "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Update File: .env.production\n*** End Patch\nPATCH",
      }),
      tool('completed', 'Bash', 'patch-1'),
    ],
  },
  {
    name: 'codex_file_change_reports_changed_files',
    events: [
      tool('started', 'file_change', 'change-1', {
        changes: [
          { path: 'src/index.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
      }),
      tool('completed', 'file_change', 'change-1'),
    ],
  },
  {
    name: 'credentials_markdown_and_long_path_are_closed',
    events: [
      { kind: 'narration', text: '检查 *链接* [点我](https://bad.example)。' },
      tool('started', 'Read', 'secret-1', {
        file_path:
          'https://user:password@example.com/very/long/private/path/to/.env.production?token=sk-secret12345678',
      }),
    ],
  },
  {
    name: 'todo_plan_switches_to_narration_window',
    events: [
      tool('started', 'TodoWrite', 'todo-1', {
        todos: [
          { content: '读取实现', status: 'completed' },
          { content: '补齐测试', status: 'in_progress' },
        ],
      }),
      { kind: 'narration', text: '先修复回调重试。' },
      tool('started', 'Read', 'read-1', { file_path: 'src/retry.ts' }),
    ],
  },
  {
    name: 'orphan_completion_is_ignored',
    events: [tool('completed', 'Read', 'missing')],
  },
  {
    name: 'codex_probe_exit_one_is_no_match',
    events: [
      tool('started', 'Bash', 'probe-1', { command: 'rg missing_symbol src' }),
      tool('failed', 'Bash', 'probe-1', undefined, { exitCode: 1 }),
    ],
  },
  {
    name: 'turn_end_marks_running_work_unknown',
    events: [
      { kind: 'narration', text: '读取配置。' },
      tool('started', 'Read', 'read-1', { file_path: 'src/config.ts' }),
      { kind: 'turn_end' },
    ],
  },
  {
    name: 'native_tool_wording_matrix',
    events: [
      tool('started', 'Agent', 'agent-1', { description: '独立复审' }),
      tool('started', 'ToolSearch', 'tool-search-1', { query: 'delegate' }),
      tool('started', 'EnterWorktree', 'worktree-1', { name: 'phase-card' }),
      tool('started', 'Skill', 'skill-1', {
        skill: 'verification-before-completion',
      }),
      tool('started', 'mcp__nanoclaw__memory_recall', 'memory-1', {
        query: '过程卡片',
      }),
      tool('started', 'mcp__nanoclaw__search_chat', 'chat-1', {
        query: 'phase',
      }),
    ],
  },
  {
    name: 'shell_redirection_and_pipe_do_not_pollute_file_target',
    events: [
      tool('started', 'Bash', 'cat-1', {
        command: 'cat src/a.ts 2>/dev/null | sed -n 1,20p',
      }),
      tool('completed', 'Bash', 'cat-1'),
      tool('started', 'Bash', 'sed-1', {
        command: "sed -n '1,20p' src/b.ts 2> /dev/null",
      }),
    ],
  },
];

const realDateNow = Date.now;
Date.now = () => FIXED_NOW;
try {
  const renderedCases = cases.map((fixtureCase) => {
    let state = createProgressPresentationState();
    const snapshots = fixtureCase.events.map((event) => {
      state = reduceProgressPresentation(state, event);
      return {
        state,
        ...buildProgressFixtureSnapshotForTest(state, {
          frame: 0,
          startTime: FIXED_NOW - 2_000,
        }),
      };
    });
    const classifications = fixtureCase.events.flatMap((event, eventIndex) =>
      event.kind === 'tool'
        ? [
            {
              eventIndex,
              action: classifyProgressAction(event.progress),
            },
          ]
        : [],
    );
    return {
      name: fixtureCase.name,
      events: fixtureCase.events,
      initialState: createProgressPresentationState(),
      snapshots,
      classifications,
    };
  });

  const casesJson = JSON.stringify(renderedCases);
  const fixture = {
    schema: 'nanoclaw-progress-card-fixture/v2',
    behaviorCommit: BEHAVIOR_COMMIT,
    exporterCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    fixedNow: FIXED_NOW,
    normalization: {
      deletedJsonPointers: [],
      rule: '完整卡片 JSON；仅允许显式 Pointer 删除不稳定叶子，本版本无需删除',
    },
    casesSha256: createHash('sha256').update(casesJson).digest('hex'),
    cases: renderedCases,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  process.stdout.write(`${OUTPUT}\n`);
} finally {
  Date.now = realDateNow;
}
