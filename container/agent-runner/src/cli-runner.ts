/**
 * CLI Runner — 使用 claude CLI（--print 模式）替代 Agent SDK
 *
 * 每轮消息 spawn 一次 `claude --print --resume <sessionId>`，
 * 通过 stream-json 格式的 stdout 获取结构化输出。
 *
 * 目的：绕过 Agent SDK 的 x-client-app header，走交互式 CLI 配额。
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── 类型定义 ───

/** Claude CLI stream-json 输出的一行 */
export interface StreamJsonLine {
  type: 'system' | 'assistant' | 'result' | 'rate_limit_event';
  subtype?: string;
  session_id?: string;
  message?: {
    model?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
      thinking?: string;
    }>;
  };
  // result 类型特有字段
  result?: string | null;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  errors?: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    contextWindow?: number;
    costUSD?: number;
  }>;
}

/** ContainerOutput — 与 agent-runner 现有输出格式一致 */
interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    modelContextWindows?: Record<string, number>;
    model?: string;
    lastTurnContext?: number;
  };
}

interface CliRunnerConfig {
  prompt: string;
  sessionId?: string;
  model?: string;
  cwd: string;
  mcpConfigPath?: string;
  additionalDirs?: string[];
  systemPromptAppend?: string;
  env?: Record<string, string | undefined>;
  allowedTools?: string[];
  permissionMode?: string;
}

// ─── 纯函数：可单元测试 ───

/**
 * 解析 stream-json 的一行 JSON
 */
export function parseStreamJsonLine(line: string): StreamJsonLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamJsonLine;
  } catch {
    return null;
  }
}

/**
 * 构建 claude CLI 参数
 */
export function buildCliArgs(config: CliRunnerConfig): string[] {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
  ];

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.sessionId) {
    args.push('--resume', config.sessionId);
  }

  if (config.mcpConfigPath) {
    args.push('--mcp-config', config.mcpConfigPath);
  }

  if (config.additionalDirs) {
    for (const dir of config.additionalDirs) {
      args.push('--add-dir', dir);
    }
  }

  if (config.systemPromptAppend) {
    args.push('--append-system-prompt', config.systemPromptAppend);
  }

  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push('--allowedTools', ...config.allowedTools);
  }

  if (config.permissionMode) {
    args.push('--permission-mode', config.permissionMode);
  }

  // 不保存 session 到磁盘（我们自己管理 sessionId）
  // 注意：如果需要 resume 功能，必须去掉这个
  // args.push('--no-session-persistence');

  return args;
}

/**
 * 生成 MCP 配置 JSON 文件，返回临时文件路径
 */
export function buildMcpConfig(
  mcpServerPath: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): string {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };

  const tmpPath = path.join(os.tmpdir(), `nanoclaw-mcp-${groupFolder}-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config), 'utf-8');
  return tmpPath;
}

/**
 * 从 stream-json assistant 消息中提取 tool_use 进度输出
 */
export function extractToolUseProgress(content: StreamJsonLine['message']): ContainerOutput | null {
  if (!content?.content) return null;

  for (const block of content.content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input;
      const emoji = block.name === 'Bash' ? '🔧' :
                    block.name === 'Read' ? '📖' :
                    block.name === 'Write' || block.name === 'Edit' ? '✏️' :
                    block.name === 'Grep' ? '🔍' :
                    block.name === 'Glob' ? '📋' :
                    block.name === 'WebSearch' || block.name === 'WebFetch' ? '🌐' : '⚙️';

      const inputStr = input
        ? ((input.command as string) || (input.file_path as string) || (input.query as string) || (input.pattern as string) || block.name)
        : block.name;
      const shortInput = typeof inputStr === 'string' ? inputStr.slice(0, 60) : block.name;

      let detail: string | undefined;
      if (input) {
        if (block.name === 'Edit' && input.old_string && input.new_string) {
          const file = ((input.file_path as string) || '').split('/').pop() || 'file';
          const oldLines = (input.old_string as string).slice(0, 300).split('\n').map((l: string) => `- ${l}`).join('\n');
          const newLines = (input.new_string as string).slice(0, 300).split('\n').map((l: string) => `+ ${l}`).join('\n');
          detail = `**${file}**\n${oldLines}\n${newLines}`;
        } else if (block.name === 'Bash' && input.command) {
          detail = `\`\`\`bash\n${(input.command as string).slice(0, 500)}\n\`\`\``;
        } else if (block.name === 'Write' && input.file_path) {
          const c = ((input.content as string) || '').slice(0, 300);
          detail = `**${input.file_path}**\n\`\`\`\n${c}${c.length >= 300 ? '\n...' : ''}\n\`\`\``;
        }
      }

      return {
        status: 'progress',
        result: `${emoji} ${block.name}: ${shortInput}`,
        progressType: 'tool_use',
        detail,
      };
    }
  }
  return null;
}

/**
 * 从 stream-json result 消息映射到 ContainerOutput
 */
export function mapResultToContainerOutput(line: StreamJsonLine): ContainerOutput {
  if (line.is_error || line.subtype === 'error_during_execution') {
    return {
      status: 'error',
      result: null,
      newSessionId: line.session_id,
      error: line.errors?.join('; ') || line.result || 'CLI execution error',
    };
  }

  const rawUsage = line.usage;
  const rawModelUsage = line.modelUsage;

  const modelContextWindows = rawModelUsage
    ? Object.fromEntries(
        Object.entries(rawModelUsage)
          .filter(([, v]) => v.contextWindow != null)
          .map(([k, v]) => [k, v.contextWindow as number]),
      )
    : undefined;

  // 获取最后使用的模型名
  const model = rawModelUsage ? Object.keys(rawModelUsage).pop() : undefined;

  // 计算 lastTurnContext（最后一轮的完整 context 大小）
  const lastModelUsage = rawModelUsage && model ? rawModelUsage[model] : undefined;
  const lastTurnContext = lastModelUsage
    ? (lastModelUsage.inputTokens ?? 0) + (lastModelUsage.cacheReadInputTokens ?? 0) + (lastModelUsage.cacheCreationInputTokens ?? 0)
    : undefined;

  const usage = rawUsage
    ? {
        inputTokens: rawUsage.input_tokens ?? 0,
        outputTokens: rawUsage.output_tokens ?? 0,
        cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
        numTurns: line.num_turns ?? 0,
        durationMs: line.duration_ms ?? 0,
        totalCostUsd: line.total_cost_usd ?? 0,
        modelContextWindows,
        model,
        lastTurnContext,
      }
    : undefined;

  return {
    status: 'success',
    result: line.result || null,
    newSessionId: line.session_id,
    usage,
  };
}

// ─── CLI Runner 主函数 ───

/**
 * 运行一轮 CLI 查询。
 * spawn `claude --print --resume <sessionId>`，解析 stream-json stdout，
 * 通过 writeOutput 回调发送 ContainerOutput。
 */
export async function runCliQuery(
  config: CliRunnerConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (msg: string) => void,
): Promise<{
  newSessionId?: string;
  closedDuringQuery: boolean;
}> {
  const args = buildCliArgs(config);
  log(`[cli-runner] spawning: claude ${args.join(' ').slice(0, 200)}`);

  // 构建 env：继承当前环境，删除 Agent SDK 标识
  const cliEnv = { ...process.env, ...config.env };
  delete cliEnv.CLAUDE_AGENT_SDK_CLIENT_APP;

  const child: ChildProcess = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cliEnv,
    cwd: config.cwd,
  });

  let newSessionId: string | undefined;
  let lastAssistantModel: string | undefined;

  // 💭 延迟去重：缓存最后一条 text block
  let pendingThought: { text: string; short: string; detail: string | undefined; timer: ReturnType<typeof setTimeout> } | null = null;
  const flushPendingThought = () => {
    if (pendingThought) {
      writeOutput({
        status: 'progress',
        result: `💭 ${pendingThought.short}`,
        progressType: 'thinking',
        detail: pendingThought.detail,
      });
      pendingThought = null;
    }
  };

  // 通过 stdin 发送 prompt（stream-json 格式）
  const inputMsg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: config.prompt },
  });
  child.stdin!.write(inputMsg + '\n');
  child.stdin!.end();

  // 解析 stdout
  let buffer = '';

  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一行可能不完整

      for (const line of lines) {
        const parsed = parseStreamJsonLine(line);
        if (!parsed) continue;

        // system/init — 获取 sessionId
        if (parsed.type === 'system' && parsed.subtype === 'init') {
          newSessionId = parsed.session_id;
          log(`[cli-runner] session init: ${newSessionId}`);
        }

        // assistant — 工具调用和文本进度
        if (parsed.type === 'assistant' && parsed.message) {
          // 记录模型
          if (parsed.message.model) {
            lastAssistantModel = parsed.message.model;
          }

          // 工具调用进度
          const toolProgress = extractToolUseProgress(parsed.message);
          if (toolProgress) {
            writeOutput(toolProgress);
          }

          // 文本内容 → 💭 推理进度（延迟去重）
          if (parsed.message.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                const trimmed = block.text.trim();
                if (trimmed.length > 5) {
                  flushPendingThought();
                  const short = trimmed.slice(0, 80) + (trimmed.length > 80 ? '...' : '');
                  pendingThought = {
                    text: trimmed,
                    short,
                    detail: trimmed.length > 80 ? trimmed : undefined,
                    timer: setTimeout(flushPendingThought, 500),
                  };
                }
              }
            }
          }
        }

        // rate_limit_event — 记录日志
        if (parsed.type === 'rate_limit_event') {
          log(`[cli-runner] rate_limit: ${JSON.stringify(parsed).slice(0, 200)}`);
        }

        // result — 最终结果
        if (parsed.type === 'result') {
          // 💭 去重
          if (pendingThought && parsed.result) {
            const resultTrimmed = (parsed.result as string).trim();
            if (resultTrimmed === pendingThought.text) {
              clearTimeout(pendingThought.timer);
              pendingThought = null;
              log('[cli-runner] deduped: result matches pending thought');
            }
          }
          flushPendingThought();

          const output = mapResultToContainerOutput(parsed);
          log(`[cli-runner] result: status=${output.status} model=${lastAssistantModel || 'unknown'} cost=$${output.usage?.totalCostUsd?.toFixed(3) || '?'}`);
          writeOutput(output);
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        for (const line of text.split('\n')) {
          if (line.trim()) log(`[cli-stderr] ${line.trim()}`);
        }
      }
    });

    child.on('close', (code) => {
      // 处理 buffer 中剩余的数据
      if (buffer.trim()) {
        const parsed = parseStreamJsonLine(buffer);
        if (parsed?.type === 'result') {
          flushPendingThought();
          writeOutput(mapResultToContainerOutput(parsed));
        }
      }

      log(`[cli-runner] process exited code=${code}`);

      if (code !== 0 && code !== null) {
        // 非零退出但没有 result → 发 error
        writeOutput({
          status: 'error',
          result: null,
          error: `CLI process exited with code ${code}`,
        });
      }

      resolve({
        newSessionId,
        closedDuringQuery: false,
      });
    });

    child.on('error', (err) => {
      log(`[cli-runner] spawn error: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to spawn claude CLI: ${err.message}`,
      });
      reject(err);
    });
  });
}

/**
 * 清理 MCP 临时配置文件
 */
export function cleanupMcpConfig(configPath: string): void {
  try {
    fs.unlinkSync(configPath);
  } catch {
    // ignore
  }
}
