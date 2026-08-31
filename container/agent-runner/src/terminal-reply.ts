import fs from 'fs';
import path from 'path';

const TERMINAL_REPLY_MARKER = '.terminal-reply';

export function writeTerminalReplyMarker(ipcDir: string): void {
  fs.mkdirSync(ipcDir, { recursive: true });
  const marker = path.join(ipcDir, TERMINAL_REPLY_MARKER);
  const temporary = `${marker}.tmp`;
  fs.writeFileSync(temporary, new Date().toISOString());
  fs.renameSync(temporary, marker);
}

export function consumeTerminalReplyMarker(ipcDir: string): boolean {
  const marker = path.join(ipcDir, TERMINAL_REPLY_MARKER);
  try {
    fs.unlinkSync(marker);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function clearTerminalReplyMarker(ipcDir: string): void {
  consumeTerminalReplyMarker(ipcDir);
}

export function suppressTerminalReplyOutput<
  T extends {
    status: 'success' | 'error' | 'progress';
    result: string | null;
    newSessionId?: string;
    usage?: unknown;
  },
>(ipcDir: string, output: T): { output: T; suppressed: boolean } {
  if (output.status === 'progress' || !consumeTerminalReplyMarker(ipcDir)) {
    return { output, suppressed: false };
  }
  return {
    output: {
      status: 'success',
      result: null,
      newSessionId: output.newSessionId,
      usage: output.usage,
    } as T,
    suppressed: true,
  };
}
