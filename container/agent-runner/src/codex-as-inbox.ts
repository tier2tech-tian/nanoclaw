import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface CodexAsInput {
  text: string;
  context?: unknown;
  senderId?: string;
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' };
  attachments?: unknown[];
  claimPath?: string;
}

/** 与旧 interactive inflight 分离，已发送消息永不被旧恢复扫描自动重放。 */
export class CodexAsInbox {
  readonly claimedDir: string;
  readonly uncertainDir: string;

  constructor(readonly inputDir: string) {
    this.claimedDir = path.join(inputDir, '.codex-as', 'claimed');
    this.uncertainDir = path.join(inputDir, '.codex-as', 'uncertain');
    fs.mkdirSync(this.claimedDir, { recursive: true });
    fs.mkdirSync(this.uncertainDir, { recursive: true });
  }

  recoverUnsent(): void {
    for (const name of fs
      .readdirSync(this.claimedDir)
      .filter((n) => n.endsWith('.json'))) {
      this.requeue(path.join(this.claimedDir, name));
    }
  }

  claim(allowOverride = false): CodexAsInput | null {
    for (const name of fs
      .readdirSync(this.inputDir)
      .filter((n) => !n.startsWith('.') && n.endsWith('.json'))
      .sort()) {
      const source = path.join(this.inputDir, name);
      const data = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (data.type !== 'message' || typeof data.text !== 'string') {
        throw new Error(`codex-as 输入格式错误，原文件已保留：${name}`);
      }
      // 后面的消息也不能越过需要变更模型的消息，保持原始顺序。
      if (!allowOverride && data.modelOverride) return null;
      const claimPath = path.join(this.claimedDir, name);
      fs.renameSync(source, claimPath);
      return { ...data, claimPath };
    }
    return null;
  }

  seed(
    text: string,
    metadata: Omit<CodexAsInput, 'text' | 'claimPath'> = {},
  ): CodexAsInput {
    const claimPath = path.join(
      this.claimedDir,
      `${Date.now()}-${randomUUID()}.json`,
    );
    fs.writeFileSync(
      claimPath,
      JSON.stringify({ type: 'message', ...metadata, text }),
      { flag: 'wx' },
    );
    return { ...metadata, text, claimPath };
  }

  submitted(input: CodexAsInput): string {
    if (!input.claimPath || path.dirname(input.claimPath) !== this.claimedDir) {
      throw new Error('codex-as 输入缺少有效认领文件');
    }
    const target = path.join(this.uncertainDir, path.basename(input.claimPath));
    fs.renameSync(input.claimPath, target);
    input.claimPath = target;
    return target;
  }

  accepted(input: CodexAsInput): void {
    if (!input.claimPath) throw new Error('codex-as 接受回执缺少原始输入');
    fs.unlinkSync(input.claimPath);
    input.claimPath = undefined;
  }

  requeue(claimPath: string): void {
    let target = path.join(this.inputDir, path.basename(claimPath));
    if (fs.existsSync(target))
      target = path.join(this.inputDir, `${Date.now()}-${randomUUID()}.json`);
    fs.renameSync(claimPath, target);
  }

  pendingUncertain(): number {
    return fs.readdirSync(this.uncertainDir).filter((n) => n.endsWith('.json'))
      .length;
  }
}
