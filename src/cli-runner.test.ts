import { describe, it, expect } from 'vitest';
import {
  parseStreamJsonLine,
  buildCliArgs,
  mapResultToContainerOutput,
  extractToolUseProgress,
  buildMcpConfig,
  cleanupMcpConfig,
} from '../container/agent-runner/src/cli-runner.js';
import type { StreamJsonLine } from '../container/agent-runner/src/cli-runner.js';
import fs from 'fs';

describe('parseStreamJsonLine', () => {
  it('解析有效 JSON 行', () => {
    const line = '{"type":"system","subtype":"init","session_id":"abc-123"}';
    const result = parseStreamJsonLine(line);
    expect(result).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
    });
  });

  it('空行返回 null', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('  ')).toBeNull();
  });

  it('无效 JSON 返回 null', () => {
    expect(parseStreamJsonLine('not json')).toBeNull();
    expect(parseStreamJsonLine('{broken')).toBeNull();
  });

  it('行首尾空白不影响解析', () => {
    const line = '  {"type":"result","subtype":"success"}  ';
    const result = parseStreamJsonLine(line);
    expect(result?.type).toBe('result');
  });
});

describe('buildCliArgs', () => {
  it('生成基础参数', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
    });
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--input-format');
  });

  it('包含 model 参数', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      model: 'claude-opus-4-6',
    });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('claude-opus-4-6');
  });

  it('包含 resume 参数', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      sessionId: 'session-uuid',
    });
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('session-uuid');
  });

  it('无 sessionId 时不包含 --resume', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
    });
    expect(args).not.toContain('--resume');
  });

  it('包含 MCP 配置路径', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      mcpConfigPath: '/tmp/mcp.json',
    });
    const idx = args.indexOf('--mcp-config');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/mcp.json');
  });

  it('包含额外目录', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      additionalDirs: ['/dir1', '/dir2'],
    });
    const addDirIndices = args.reduce((acc: number[], v, i) => {
      if (v === '--add-dir') acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices).toHaveLength(2);
    expect(args[addDirIndices[0] + 1]).toBe('/dir1');
    expect(args[addDirIndices[1] + 1]).toBe('/dir2');
  });

  it('包含 system prompt append', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      systemPromptAppend: 'extra context',
    });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('extra context');
  });

  it('包含 permission mode', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
    });
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('bypassPermissions');
  });

  it('包含 allowed tools', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      cwd: '/tmp',
      allowedTools: ['Bash', 'Read', 'Edit'],
    });
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Bash');
    expect(args[idx + 2]).toBe('Read');
    expect(args[idx + 3]).toBe('Edit');
  });
});

describe('mapResultToContainerOutput', () => {
  it('映射成功结果', () => {
    const line: StreamJsonLine = {
      type: 'result',
      subtype: 'success',
      result: '好',
      session_id: 'sess-1',
      is_error: false,
      duration_ms: 2000,
      duration_api_ms: 1900,
      num_turns: 1,
      total_cost_usd: 0.015,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 2000,
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 2000,
          contextWindow: 200000,
          costUSD: 0.015,
        },
      },
    };

    const output = mapResultToContainerOutput(line);
    expect(output.status).toBe('success');
    expect(output.result).toBe('好');
    expect(output.newSessionId).toBe('sess-1');
    expect(output.usage).toBeDefined();
    expect(output.usage!.inputTokens).toBe(100);
    expect(output.usage!.outputTokens).toBe(10);
    expect(output.usage!.cacheReadInputTokens).toBe(5000);
    expect(output.usage!.numTurns).toBe(1);
    expect(output.usage!.totalCostUsd).toBe(0.015);
    expect(output.usage!.model).toBe('claude-haiku-4-5-20251001');
    expect(output.usage!.modelContextWindows).toEqual({
      'claude-haiku-4-5-20251001': 200000,
    });
    // lastTurnContext = inputTokens + cacheRead + cacheCreation
    expect(output.usage!.lastTurnContext).toBe(100 + 5000 + 2000);
  });

  it('映射错误结果', () => {
    const line: StreamJsonLine = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'sess-2',
      errors: ['No conversation found', 'Session expired'],
    };

    const output = mapResultToContainerOutput(line);
    expect(output.status).toBe('error');
    expect(output.error).toBe('No conversation found; Session expired');
    expect(output.newSessionId).toBe('sess-2');
  });

  it('无 usage 时 usage 为 undefined', () => {
    const line: StreamJsonLine = {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      is_error: false,
    };

    const output = mapResultToContainerOutput(line);
    expect(output.status).toBe('success');
    expect(output.usage).toBeUndefined();
  });

  it('result 为 null 时正确处理', () => {
    const line: StreamJsonLine = {
      type: 'result',
      subtype: 'success',
      result: null,
      is_error: false,
    };

    const output = mapResultToContainerOutput(line);
    expect(output.result).toBeNull();
  });
});

describe('extractToolUseProgress', () => {
  it('提取 Bash 工具调用', () => {
    const output = extractToolUseProgress({
      content: [{
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'git status' },
      }],
    });
    expect(output).not.toBeNull();
    expect(output!.status).toBe('progress');
    expect(output!.progressType).toBe('tool_use');
    expect(output!.result).toContain('🔧');
    expect(output!.result).toContain('Bash');
    expect(output!.result).toContain('git status');
  });

  it('提取 Edit 工具调用并生成 detail', () => {
    const output = extractToolUseProgress({
      content: [{
        type: 'tool_use',
        name: 'Edit',
        input: {
          file_path: '/src/index.ts',
          old_string: 'foo',
          new_string: 'bar',
        },
      }],
    });
    expect(output).not.toBeNull();
    expect(output!.result).toContain('✏️');
    expect(output!.detail).toContain('index.ts');
    expect(output!.detail).toContain('- foo');
    expect(output!.detail).toContain('+ bar');
  });

  it('提取 Read 工具调用', () => {
    const output = extractToolUseProgress({
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/path/to/file.ts' },
      }],
    });
    expect(output).not.toBeNull();
    expect(output!.result).toContain('📖');
  });

  it('text 类型不产生工具进度', () => {
    const output = extractToolUseProgress({
      content: [{
        type: 'text',
        text: 'just some text',
      }],
    });
    expect(output).toBeNull();
  });

  it('空 content 返回 null', () => {
    expect(extractToolUseProgress({ content: [] })).toBeNull();
    expect(extractToolUseProgress({})).toBeNull();
    expect(extractToolUseProgress(undefined)).toBeNull();
  });

  it('WebSearch 使用 🌐 emoji', () => {
    const output = extractToolUseProgress({
      content: [{
        type: 'tool_use',
        name: 'WebSearch',
        input: { query: 'test query' },
      }],
    });
    expect(output!.result).toContain('🌐');
  });
});

describe('buildMcpConfig', () => {
  it('生成临时 MCP 配置文件', () => {
    const configPath = buildMcpConfig(
      '/path/to/mcp-server.js',
      'chat-jid-1',
      'fs_oc_test',
      true,
      '/ipc/dir',
    );

    expect(fs.existsSync(configPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(content.mcpServers.nanoclaw.command).toBe('node');
    expect(content.mcpServers.nanoclaw.args).toEqual(['/path/to/mcp-server.js']);
    expect(content.mcpServers.nanoclaw.env.NANOCLAW_CHAT_JID).toBe('chat-jid-1');
    expect(content.mcpServers.nanoclaw.env.NANOCLAW_GROUP_FOLDER).toBe('fs_oc_test');
    expect(content.mcpServers.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('1');
    expect(content.mcpServers.nanoclaw.env.NANOCLAW_IPC_DIR).toBe('/ipc/dir');

    // 清理
    cleanupMcpConfig(configPath);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('isMain=false 设置 NANOCLAW_IS_MAIN=0', () => {
    const configPath = buildMcpConfig(
      '/mcp.js', 'jid', 'folder', false, '/ipc',
    );
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(content.mcpServers.nanoclaw.env.NANOCLAW_IS_MAIN).toBe('0');
    cleanupMcpConfig(configPath);
  });
});

describe('cleanupMcpConfig', () => {
  it('删除不存在的文件不报错', () => {
    expect(() => cleanupMcpConfig('/nonexistent/path.json')).not.toThrow();
  });
});
