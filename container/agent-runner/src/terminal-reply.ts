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

export function clearTerminalReplyMarker(ipcDir: string): boolean {
  try {
    fs.unlinkSync(path.join(ipcDir, TERMINAL_REPLY_MARKER));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function suppressTerminalReplyOutput<
  T extends {
    status: 'success' | 'error' | 'progress';
    result: string | null;
    newSessionId?: string;
    terminalReply?: boolean;
  },
>(ipcDir: string, output: T): { output: T; suppressed: boolean } {
  if (output.status !== 'success' || !clearTerminalReplyMarker(ipcDir)) {
    return { output, suppressed: false };
  }
  return {
    output: {
      ...output,
      status: 'success',
      result: null,
      error: undefined,
      terminalReply: true,
    } as T,
    suppressed: true,
  };
}
