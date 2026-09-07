const generations = new Map<string, number>();

/** /mode 即使切回同一个名字，也不能重新接受旧进程的输出。 */
export function invalidateModeRun(jid: string): void {
  generations.set(jid, (generations.get(jid) ?? 0) + 1);
}

export function captureModeRun(jid: string): () => boolean {
  const generation = generations.get(jid) ?? 0;
  return () => (generations.get(jid) ?? 0) === generation;
}
