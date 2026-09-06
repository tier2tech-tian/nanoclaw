import type { ContainerOutput } from './container-runner.js';

/** 新模式只认显式终态，任何新进度表示新一轮尚未结算。 */
export class CodexAsTerminal {
  private terminal?: ContainerOutput;
  observe(output: ContainerOutput): void {
    this.terminal = output.status === 'progress' ? undefined : output;
  }
  settled(): ContainerOutput | undefined {
    return this.terminal;
  }
  interrupted(reason: string): ContainerOutput {
    return (
      this.terminal ?? {
        status: 'error',
        result: `codex-as 未正常完成：${reason}；已停止自动重试，请确认本轮执行结果后再继续。`,
        error: `codex-as 未正常完成：${reason}`,
      }
    );
  }
}
