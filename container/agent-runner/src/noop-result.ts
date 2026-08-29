/**
 * 空壳 result 判定：SDK resume 时旧后台任务停止通知产生的无效 result。
 * 字段必须明确存在且等于 0，缺失(undefined)不算——防吞协议异常。
 */
export function isNoOpResult(
  hasResult: boolean,
  promotedFinalText: string | null,
  numTurns: number | undefined,
  rawUsage: { input_tokens?: number; output_tokens?: number } | undefined,
): boolean {
  return !hasResult && !promotedFinalText
    && numTurns === 0
    && rawUsage !== undefined
    && rawUsage.input_tokens === 0
    && rawUsage.output_tokens === 0;
}
