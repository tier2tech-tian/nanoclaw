import type { Channel } from './types.js';

/**
 * 输出过滤器 — 拦截不应发送给用户的 agent 输出
 *
 * 两类过滤：
 * 1. thinking progress — 只能走 Channel 专用进度载体，禁止作为普通消息发送（会触发新一轮处理）
 * 2. 模型拒绝文本 — "No response requested." 等，模型认为不需要回复时产生的文本
 */

// 模型拒绝回复文本 — 这些不应发给用户（会触发死循环）
// 注意：必须精确匹配完整短句（以句号或行尾结束），避免误拦截 "Not applicable here because..." 等正常回复
export const MODEL_REFUSAL_PATTERN =
  /^(?:No response requested\.|I don't have (?:a |any )?(?:response|reply)\.?|not applicable\.?)$/i;

/**
 * 判断 progress 类型是否应被过滤（不发给用户）
 * 目前只过滤 thinking 类型
 */
export function shouldFilterProgress(
  progressType: string | undefined,
): boolean {
  return progressType === 'thinking';
}

/**
 * thinking 只走 Channel 专用进度能力。返回 true 表示该事件已被消费，
 * 即使当前 Channel 不支持也不能降级为普通消息。
 */
export async function routeThinkingProgress(
  channel: Channel,
  jid: string,
  progressType: string | undefined,
  text: string,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  if (progressType !== 'thinking') return false;
  try {
    await channel.updateThinking?.(jid, text);
  } catch (err) {
    onError?.(err);
  }
  return true;
}

/**
 * 判断最终回复文本是否为模型拒绝文本（不应发给用户）
 */
export function isModelRefusal(text: string): boolean {
  return MODEL_REFUSAL_PATTERN.test(text);
}
