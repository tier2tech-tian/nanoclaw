import { describe, it, expect } from 'vitest';

/**
 * 空壳 result 判定逻辑的单元测试。
 * 验证 isNoOp 条件：字段必须明确存在且等于 0，缺失不算。
 */

interface ResultMsg {
  num_turns?: number;
  total_cost_usd?: number;
}
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
}

function isNoOpResult(
  hasResult: boolean,
  promotedFinalText: string | null,
  numTurns: number | undefined,
  rawUsage: RawUsage | undefined,
): boolean {
  return !hasResult && !promotedFinalText
    && numTurns === 0
    && rawUsage !== undefined
    && rawUsage.input_tokens === 0
    && rawUsage.output_tokens === 0;
}

describe('isNoOpResult 空壳 result 判定', () => {
  it('标准空壳：0 turns + 0 usage + 无 result → true', () => {
    expect(isNoOpResult(false, null, 0, { input_tokens: 0, output_tokens: 0 })).toBe(true);
  });

  it('有文本 result → false（不管 usage 如何）', () => {
    expect(isNoOpResult(true, null, 0, { input_tokens: 0, output_tokens: 0 })).toBe(false);
  });

  it('有 promotedFinalText → false', () => {
    expect(isNoOpResult(false, '收尾文本', 0, { input_tokens: 0, output_tokens: 0 })).toBe(false);
  });

  it('numTurns > 0 → false（真实轮次）', () => {
    expect(isNoOpResult(false, null, 1, { input_tokens: 0, output_tokens: 0 })).toBe(false);
  });

  it('numTurns 缺失(undefined) → false（不吞协议异常）', () => {
    expect(isNoOpResult(false, null, undefined, { input_tokens: 0, output_tokens: 0 })).toBe(false);
  });

  it('rawUsage 缺失(undefined) → false（不吞协议异常）', () => {
    expect(isNoOpResult(false, null, 0, undefined)).toBe(false);
  });

  it('input_tokens > 0 → false（有实际 API 调用）', () => {
    expect(isNoOpResult(false, null, 0, { input_tokens: 100, output_tokens: 0 })).toBe(false);
  });

  it('output_tokens > 0 → false（有实际输出）', () => {
    expect(isNoOpResult(false, null, 0, { input_tokens: 0, output_tokens: 50 })).toBe(false);
  });

  it('input_tokens 缺失 → false（字段必须明确存在）', () => {
    expect(isNoOpResult(false, null, 0, { output_tokens: 0 })).toBe(false);
  });

  it('真实 result（8 turns + usage）→ false', () => {
    expect(isNoOpResult(true, null, 8, { input_tokens: 50000, output_tokens: 2000 })).toBe(false);
  });
});
