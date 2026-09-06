import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCodexConfigToml,
  buildCodexEnv,
  buildGitNexusMcpServerConfig,
  isGitNexusCommandAvailable,
  prepareCodexHome,
  mapCodexProgress,
  mapCodexTextProgress,
  createCodexTextProgressState,
  mapCodexUsage,
  type CodexRunnerConfig,
  type CodexEvent,
} from './codex-runner.js';
import type { ContainerOutput } from './cli-runner.js';
import { CodexAsInbox, type CodexAsInput } from './codex-as-inbox.js';
import { CodexAsRpc, CodexAsRpcError } from './codex-as-rpc.js';

export interface CodexAsConfig extends CodexRunnerConfig {
  modelOverride?: CodexAsInput['modelOverride'];
  initialInput?: CodexAsInput;
  attachments?: unknown[];
  formatInput?: (message: CodexAsInput) => string;
  shouldClose?: () => boolean;
  attachmentRoot?: string;
  rpcTimeoutMs?: number;
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
}

export function mapAsItem(
  item: Record<string, any>,
  completed: boolean,
): CodexEvent {
  const types: Record<string, string> = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
  };
  return {
    type: completed ? 'item.completed' : 'item.started',
    item: {
      id: item.id,
      type: types[item.type] ?? item.type,
      text:
        item.type === 'reasoning' ? (item.summary ?? []).join('\n') : item.text,
      command: item.command,
      aggregated_output: item.aggregatedOutput,
      exit_code: item.exitCode,
      status: item.status,
      server: item.server,
      tool: item.tool,
      arguments: item.arguments,
      changes: item.changes?.map((c: any) => ({
        path: c.path,
        kind: typeof c.kind === 'string' ? c.kind : c.kind?.type,
      })),
    },
  };
}

export function asInputContent(
  input: CodexAsInput,
  text: string,
  allowedRoot: string,
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [{ type: 'text', text }];
  for (const raw of input.attachments ?? []) {
    const attachment = raw as { type?: string; path?: string };
    if (attachment.type !== 'image' || !attachment.path)
      throw new Error('codex-as 附件格式无效');
    const root = fs.realpathSync(allowedRoot);
    const file = fs.realpathSync(attachment.path);
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !fs.statSync(file).isFile()
    ) {
      throw new Error('codex-as 图片必须位于当前群目录内');
    }
    content.push({ type: 'localImage', path: file });
  }
  return content;
}

export async function runCodexAsQuery(
  config: CodexAsConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{ newSessionId?: string; result?: string; failed?: boolean }> {
  const inbox = new CodexAsInbox(path.join(config.ipcDir, 'input'));
  const priorUncertain = inbox.pendingUncertain();
  const initial =
    config.initialInput ??
    inbox.seed(config.prompt, {
      senderId: config.senderId,
      attachments: config.attachments,
      modelOverride: config.modelOverride,
    });
  initial.attachments ??= config.attachments;
  let rpc: CodexAsRpc | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let textState = createCodexTextProgressState();
  let terminal: Record<string, any> | undefined;
  let rejectedInput: CodexAsInput | undefined;
  let usage: ContainerOutput['usage'];
  let lastActivity = Date.now();
  let interrupted = false;
  const startedAt = Date.now();
  const format = config.formatInput ?? ((input: CodexAsInput) => input.text);
  const content = (input: CodexAsInput, text = format(input)) =>
    asInputContent(input, text, config.attachmentRoot ?? config.cwd);

  try {
    writeOutput({ status: 'progress', result: null });
    const extraMcpServers = isGitNexusCommandAvailable(config.env)
      ? [buildGitNexusMcpServerConfig()]
      : [];
    prepareCodexHome(
      config.codexHome,
      config.env.HOME ?? os.homedir(),
      buildCodexConfigToml({ ...config, extraMcpServers }),
      log,
    );
    rpc = new CodexAsRpc(
      buildCodexEnv(config.env, config.codexHome),
      config.cwd,
      config.rpcTimeoutMs ?? 30000,
      log,
    );
    await rpc.request('initialize', {
      clientInfo: { name: 'nanoclaw_codex_as', version: '1.0' },
    });
    rpc.notify('initialized');
    const thread = await rpc.request(
      config.sessionId ? 'thread/resume' : 'thread/start',
      {
        ...(config.sessionId ? { threadId: config.sessionId } : {}),
        model: config.model,
        cwd: config.cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        serviceTier: config.serviceTier === 'fast' ? 'fast' : 'default',
      },
    );
    if (typeof thread?.thread?.id !== 'string')
      throw new Error('codex-as 未返回有效 threadId');
    threadId = thread.thread.id;

    const start = async (input: CodexAsInput, text?: string) => {
      const prepared = content(input, text);
      inbox.submitted(input);
      const result = await rpc!.request('turn/start', {
        threadId,
        input: prepared,
        clientUserMessageId: path.basename(input.claimPath!),
        model: config.model,
        effort: config.effort,
      });
      if (typeof result?.turn?.id !== 'string')
        throw new Error('codex-as 未返回有效 turnId');
      turnId = result.turn.id;
      inbox.accepted(input);
      terminal = undefined;
      textState = createCodexTextProgressState();
      lastActivity = Date.now();
      log(`[codex-as] turn/start accepted thread=${threadId} turn=${turnId}`);
    };

    const consume = () => {
      for (const event of rpc!.events.splice(0)) {
        const p = event.params;
        const eventTurnId =
          event.method === 'turn/completed' ? p.turn?.id : p.turnId;
        if (p.threadId !== threadId || eventTurnId !== turnId) continue;
        lastActivity = Date.now();
        if (event.method === 'turn/completed') {
          terminal = p.turn;
        } else if (
          event.method === 'item/started' ||
          event.method === 'item/completed'
        ) {
          if (!p.item || typeof p.item.id !== 'string') continue;
          if (
            ![
              'agentMessage',
              'reasoning',
              'commandExecution',
              'fileChange',
              'mcpToolCall',
              'webSearch',
              'imageView',
            ].includes(p.item.type)
          )
            continue;
          const mapped = mapAsItem(p.item, event.method === 'item/completed');
          for (const output of mapCodexTextProgress(mapped, textState))
            writeOutput(output);
          for (const output of mapCodexProgress(mapped)) writeOutput(output);
        } else if (event.method === 'thread/tokenUsage/updated') {
          const last = p.tokenUsage?.last;
          if (last) {
            usage = mapCodexUsage(
              {
                input_tokens: last.inputTokens,
                output_tokens: last.outputTokens,
                cached_input_tokens: last.cachedInputTokens,
              },
              {
                model: config.model,
                modelContextWindow: p.tokenUsage.modelContextWindow,
                lastTurnContext: last.inputTokens,
              },
              config.effort,
            );
          }
        }
      }
    };

    await start(initial, config.prompt);
    while (true) {
      consume();
      if (terminal) {
        if (terminal.status !== 'completed') {
          if (rejectedInput?.claimPath) {
            inbox.requeue(rejectedInput.claimPath);
            rejectedInput = undefined;
          }
          throw new Error(
            terminal.error?.message ?? `任务已中断（${terminal.status}）`,
          );
        }
        if (rejectedInput) {
          if (textState.lastAgentMessage)
            writeOutput({
              status: 'progress',
              result: textState.lastAgentMessage,
              progressType: 'text',
              detail: textState.lastAgentMessage,
            });
          const next = rejectedInput;
          rejectedInput = undefined;
          await start(next);
          continue;
        }
        break;
      }
      if (rpc.failure) throw rpc.failure;
      if (
        Date.now() - lastActivity >
        (config.idleTimeoutMs ?? 10 * 60 * 1000)
      ) {
        throw new Error('codex-as 长时间无有效事件，任务结果未确认');
      }
      if (config.shouldClose?.() && !interrupted) {
        interrupted = true;
        await rpc.request('turn/interrupt', { threadId, turnId });
        continue;
      }
      if (!interrupted && !rejectedInput) {
        const input = inbox.claim();
        if (input) {
          const prepared = content(input);
          inbox.submitted(input);
          try {
            const result = await rpc.request('turn/steer', {
              threadId,
              expectedTurnId: turnId,
              input: prepared,
              clientUserMessageId: path.basename(input.claimPath!),
            });
            if (result?.turnId !== turnId)
              throw new Error('codex-as 补充回执轮次不匹配');
            inbox.accepted(input);
            log(`[codex-as] steer accepted turn=${turnId}`);
          } catch (error) {
            // 只在服务器明确拒绝且未接收输入时允许进入下一轮。
            if (
              error instanceof CodexAsRpcError &&
              error.code === -32600 &&
              /no active turn to steer|expected turn.*(?:mismatch|does not match)|turn id mismatch/i.test(
                error.message,
              )
            ) {
              const target = path.join(
                inbox.claimedDir,
                path.basename(input.claimPath!),
              );
              fs.renameSync(input.claimPath!, target);
              input.claimPath = target;
              rejectedInput = input;
              log(
                '[codex-as] steer explicitly rejected; waiting for parent settlement',
              );
            } else throw error;
          }
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, config.pollIntervalMs ?? 100),
      );
    }

    const notice =
      priorUncertain > 0
        ? `此前有 ${priorUncertain} 条输入送达状态未确认，已保留且未自动重发。\n\n`
        : '';
    const result = notice + (textState.lastAgentMessage ?? '');
    if (usage) usage.durationMs = Date.now() - startedAt;
    writeOutput({
      status: 'success',
      result: result || null,
      newSessionId: threadId,
      usage,
    });
    return { newSessionId: threadId, result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 可见错误正文让宿主推进已交付游标；新模式同时禁用通用自动重试。
    const preserved = inbox.pendingUncertain();
    const result = `codex-as 执行失败：${detail}${preserved ? `；${preserved} 条输入的执行状态未确认，原文已保留，未自动重发。` : ''}`;
    log(`[codex-as] failed uncertain=${preserved}`);
    writeOutput({
      status: 'error',
      result,
      error: result,
      newSessionId: threadId,
    });
    return { newSessionId: threadId, failed: true };
  } finally {
    await rpc?.close();
  }
}
