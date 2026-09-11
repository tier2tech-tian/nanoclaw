import fs from 'fs';
import path from 'path';

/** 仅在Codex轮次边界检查；与会中会触发interrupt的_close严格分开。 */
export function shouldRetireCodex(inputDir: string): boolean {
  return (
    fs.existsSync(path.join(inputDir, '_retire')) &&
    !fs
      .readdirSync(inputDir)
      .some((name) => !name.startsWith('.') && name.endsWith('.json'))
  );
}
