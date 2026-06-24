/**
 * 错误分类 + 脱敏 + stderr ring buffer
 *
 * 纯函数为主，零外部依赖，方便单测。
 * 对应 OpenSpec: agent-runner-error-classification
 */

// ---- 脱敏 ----

const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string | ((match: string) => string) }> = [
  // Anthropic API key / OAuth token
  { pattern: /sk-ant-[a-zA-Z0-9_-]+/g, replacement: 'sk-ant-***' },
  // OneCLI proxy token
  { pattern: /aoc_[a-fA-F0-9]+/g, replacement: 'aoc_***' },
  // Authorization / Proxy-Authorization header 整个 value
  {
    pattern: /(?:Authorization|Proxy-Authorization):\s*(?:Bearer|Basic)?\s*\S+/gi,
    replacement: (match: string) => {
      const colonIdx = match.indexOf(':');
      return match.slice(0, colonIdx) + ': ***';
    },
  },
  // 代理 URL userinfo (http(s)://user:pass@host)
  { pattern: /https?:\/\/[^@\s]+@/g, replacement: (match: string) => {
    const scheme = match.startsWith('https') ? 'https' : 'http';
    return `${scheme}://***:***@`;
  }},
];

/**
 * 对文本应用全部脱敏规则。
 * 覆盖 error_detail 和 [cli-stderr] 两个出口。
 */
export function redactSensitive(text: string): string {
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement as string);
  }
  return result;
}

// ---- 错误分类 ----

export type ErrorClass =
  | 'auth_error'
  | 'proxy_auth_error'
  | 'rate_limit_error'
  | 'model_error'
  | 'context_error'
  | 'config_error'
  | 'network_error'
  | 'cli_crash'
  | 'unknown_silent';

interface ClassificationRule {
  pattern: RegExp;
  errorClass: ErrorClass;
}

// 按优先级排列，首匹配即停
const CLASSIFICATION_RULES: ClassificationRule[] = [
  { pattern: /\b(401|403|Unauthorized|Forbidden|invalid x-api-key|OAuth.*expir|token.*invalid)\b/i, errorClass: 'auth_error' },
  { pattern: /\b(407|Proxy.?Auth|Proxy Authentication)\b/i, errorClass: 'proxy_auth_error' },
  { pattern: /\b429\b|rate_limit|too many requests/i, errorClass: 'rate_limit_error' },
  { pattern: /\b404\b.*model|model.*\b404\b|model.*not.?found|Could not resolve the model/i, errorClass: 'model_error' },
  { pattern: /context_length_exceeded|max.*token.*exceeded/i, errorClass: 'context_error' },
  { pattern: /EISDIR|ENOTDIR|ENOENT|EACCES|permission denied|ENOSPC|EROFS|No space left/i, errorClass: 'config_error' },
  { pattern: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timeout|UnknownIssuer|SELF_SIGNED_CERT_IN_CHAIN|unable to verify/i, errorClass: 'network_error' },
];

/**
 * 对 0 消息场景分类错误原因。
 * 在完整 stderr buffer 上做 regex 匹配，首匹配即停。
 */
export function classifyError(
  stderrContent: string,
  exitCode: number | null,
): ErrorClass {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(stderrContent)) {
      return rule.errorClass;
    }
  }
  // 规则 8: exit code !== 0 且非 null
  if (exitCode !== null && exitCode !== 0) {
    return 'cli_crash';
  }
  // 规则 9: 兜底
  return 'unknown_silent';
}

// ---- Stderr Ring Buffer ----

const RING_BUFFER_SIZE = 8 * 1024; // 8KB
const ERROR_DETAIL_MAX = 500;

/**
 * 8KB ring buffer，持续缓存 CLI stderr 输出。
 * query() 结束后用于错误分类和 error_detail 截取。
 */
export class StderrRingBuffer {
  private chunks: string[] = [];
  private totalLength = 0;

  append(data: string): void {
    this.chunks.push(data);
    this.totalLength += data.length;
    // 惰性压缩：总长度超 2 倍阈值时合并
    if (this.totalLength > RING_BUFFER_SIZE * 2) {
      this.compact();
    }
  }

  /** 返回完整 buffer 内容（最多 8KB） */
  getContent(): string {
    const full = this.chunks.join('');
    if (full.length <= RING_BUFFER_SIZE) return full;
    return full.slice(full.length - RING_BUFFER_SIZE);
  }

  /** 返回最后 500 字符（用于 error_detail），已脱敏 */
  getErrorDetail(): string {
    const content = this.getContent();
    const tail = content.length <= ERROR_DETAIL_MAX
      ? content
      : content.slice(content.length - ERROR_DETAIL_MAX);
    return redactSensitive(tail);
  }

  private compact(): void {
    const content = this.getContent();
    this.chunks = [content];
    this.totalLength = content.length;
  }
}

// ---- Terminal frame 构建 ----

export interface ErrorTerminalFrame {
  status: 'error';
  error_class: ErrorClass;
  error_detail: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface SuccessTerminalFrame {
  status: 'success';
}

export type TerminalFrame = ErrorTerminalFrame | SuccessTerminalFrame;

/**
 * query() 结束后生成 terminal frame。
 * messageCount > 0 → success；0 → 分析 stderr 生成错误分类。
 */
export function buildTerminalFrame(
  messageCount: number,
  stderrBuffer: StderrRingBuffer,
  exitCode: number | null,
  durationMs: number,
): TerminalFrame {
  if (messageCount > 0) {
    return { status: 'success' };
  }
  return {
    status: 'error',
    error_class: classifyError(stderrBuffer.getContent(), exitCode),
    error_detail: stderrBuffer.getErrorDetail(),
    exit_code: exitCode,
    duration_ms: durationMs,
  };
}
