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

export function hasTerminalReplyMarker(ipcDir: string): boolean {
  return fs.existsSync(path.join(ipcDir, TERMINAL_REPLY_MARKER));
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
