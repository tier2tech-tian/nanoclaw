import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

export interface AsNotification {
  method: string;
  params: Record<string, any>;
}

export class CodexAsRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 请求回执独立于事件流，避免在等待 steer 时阻塞 completed 的接收。 */
export class CodexAsRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: AsNotification[] = [];
  failure?: Error;
  private id = 0;
  private closing = false;
  private closed: Promise<void>;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    env: NodeJS.ProcessEnv,
    cwd: string,
    private timeoutMs: number,
    log: (s: string) => void,
  ) {
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.method && frame.id !== undefined) {
          this.child.stdin.write(
            JSON.stringify({
              id: frame.id,
              error: {
                code: -32601,
                message: '此接入暂不支持该交互请求，请使用已提供的 MCP 工具',
              },
            }) + '\n',
          );
        } else if (frame.id !== undefined) {
          const entry = this.pending.get(frame.id);
          if (!entry) return;
          this.pending.delete(frame.id);
          clearTimeout(entry.timer);
          if (frame.error)
            entry.reject(
              new CodexAsRpcError(
                frame.error.code,
                String(frame.error.message),
              ),
            );
          else entry.resolve(frame.result);
        } else if (typeof frame.method === 'string') {
          this.events.push({
            method: frame.method,
            params: frame.params ?? {},
          });
        }
      } catch {
        this.fail(new Error('codex-as 收到非法协议数据'));
      }
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    // stderr 只留长度，避免认证或工具原文进入共享日志。
    this.child.stderr.on('data', (b: Buffer) =>
      log(`[codex-as] stderr bytes=${b.length}`),
    );
    this.closed = new Promise((resolve) =>
      this.child.on('close', (code, signal) => {
        lines.close();
        if (!this.closing)
          this.fail(
            new Error(
              `codex-as 进程提前退出 code=${code} signal=${signal ?? 'none'}`,
            ),
          );
        resolve();
      }),
    );
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex-as ${method} 回执超时，未自动重试`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ id, method, params }) + '\n',
        (error) => {
          if (error) this.fail(error);
        },
      );
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ method }) + '\n');
  }

  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error('codex-as 连接已关闭'));
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill('SIGTERM'), 500);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.closed;
    clearTimeout(term);
    clearTimeout(kill);
  }
}
