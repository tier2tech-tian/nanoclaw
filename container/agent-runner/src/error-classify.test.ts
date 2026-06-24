/**
 * 错误分类 + 脱敏 + stderr ring buffer 单测
 * 零 mock 纯函数测试
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  redactSensitive,
  StderrRingBuffer,
  buildTerminalFrame,
} from './error-classify.js';

// ---- classifyError ----

describe('classifyError', () => {
  it('401 → auth_error', () => {
    expect(classifyError('Error: 401 Unauthorized', null)).toBe('auth_error');
  });

  it('403 Forbidden → auth_error', () => {
    expect(classifyError('HTTP 403 Forbidden', null)).toBe('auth_error');
  });

  it('invalid x-api-key → auth_error', () => {
    expect(classifyError('invalid x-api-key header', null)).toBe('auth_error');
  });

  it('407 → proxy_auth_error', () => {
    expect(classifyError('HTTP/1.1 407 Proxy Authentication Required', null)).toBe('proxy_auth_error');
  });

  it('429 → rate_limit_error', () => {
    expect(classifyError('HTTP 429 Too Many Requests', null)).toBe('rate_limit_error');
  });

  it('rate_limit → rate_limit_error', () => {
    expect(classifyError('rate_limit exceeded', null)).toBe('rate_limit_error');
  });

  it('model 404 → model_error', () => {
    expect(classifyError('404 model not found', null)).toBe('model_error');
  });

  it('Could not resolve the model → model_error', () => {
    expect(classifyError('Could not resolve the model "claude-99"', null)).toBe('model_error');
  });

  it('context_length_exceeded → context_error', () => {
    expect(classifyError('context_length_exceeded: max 200000 tokens', null)).toBe('context_error');
  });

  it('EISDIR → config_error', () => {
    expect(classifyError('EISDIR: illegal operation on a directory', null)).toBe('config_error');
  });

  it('ENOSPC → config_error', () => {
    expect(classifyError('ENOSPC: No space left on device', null)).toBe('config_error');
  });

  it('ECONNREFUSED → network_error', () => {
    expect(classifyError('connect ECONNREFUSED 127.0.0.1:443', null)).toBe('network_error');
  });

  it('UnknownIssuer → network_error', () => {
    expect(classifyError('Error: UnknownIssuer certificate', null)).toBe('network_error');
  });

  it('SELF_SIGNED_CERT_IN_CHAIN → network_error', () => {
    expect(classifyError('SELF_SIGNED_CERT_IN_CHAIN', null)).toBe('network_error');
  });

  it('exit code 非零且无关键词 → cli_crash', () => {
    expect(classifyError('some random error', 1)).toBe('cli_crash');
  });

  it('exit code 为 null → unknown_silent (跳过 cli_crash)', () => {
    expect(classifyError('some random error', null)).toBe('unknown_silent');
  });

  it('空 stderr + exit code 0 → unknown_silent', () => {
    expect(classifyError('', 0)).toBe('unknown_silent');
  });

  it('优先级：401 + timeout 同时匹配 → auth_error（优先级 1 > 7）', () => {
    expect(classifyError('Error: 401 connection timeout', null)).toBe('auth_error');
  });

  it('优先级：429 + ECONNREFUSED → rate_limit_error（优先级 3 > 7）', () => {
    expect(classifyError('429 rate limit ECONNREFUSED', null)).toBe('rate_limit_error');
  });

  it('lowercase unauthorized → auth_error', () => {
    expect(classifyError('error: unauthorized access', null)).toBe('auth_error');
  });

  it('mixed case Forbidden → auth_error', () => {
    expect(classifyError('HTTP 403 forbidden', null)).toBe('auth_error');
  });

  it('lowercase proxy authentication → proxy_auth_error', () => {
    expect(classifyError('proxy authentication required', null)).toBe('proxy_auth_error');
  });
});

// ---- redactSensitive ----

describe('redactSensitive', () => {
  it('脱敏 sk-ant- API key', () => {
    expect(redactSensitive('key is sk-ant-api03-abc123def456')).toBe('key is sk-ant-***');
  });

  it('脱敏 aoc_ proxy token', () => {
    expect(redactSensitive('token: aoc_34a288823ae8')).toBe('token: aoc_***');
  });

  it('脱敏 Authorization Bearer header', () => {
    expect(redactSensitive('Authorization: Bearer sk-ant-oat01-abc123')).toBe('Authorization: ***');
  });

  it('脱敏 Proxy-Authorization Basic header', () => {
    expect(redactSensitive('Proxy-Authorization: Basic dXNlcjpwYXNz')).toBe('Proxy-Authorization: ***');
  });

  it('脱敏代理 URL userinfo', () => {
    expect(redactSensitive('http://x:aoc_34a288823ae8@192.168.100.1:10255'))
      .toBe('http://***:***@192.168.100.1:10255');
  });

  it('https 代理 URL userinfo', () => {
    expect(redactSensitive('https://user:pass@proxy.example.com:443'))
      .toBe('https://***:***@proxy.example.com:443');
  });

  it('无敏感信息原样返回', () => {
    const clean = 'Normal log message without secrets';
    expect(redactSensitive(clean)).toBe(clean);
  });

  it('多种敏感信息同时出现全部脱敏', () => {
    const input = 'sk-ant-api03-xxx and aoc_aabb and http://u:p@host:80';
    const result = redactSensitive(input);
    expect(result).not.toContain('sk-ant-api03');
    expect(result).not.toContain('aoc_aabb');
    expect(result).not.toContain('u:p@');
  });
});

// ---- StderrRingBuffer ----

describe('StderrRingBuffer', () => {
  it('小于 8KB 返回完整内容', () => {
    const buf = new StderrRingBuffer();
    buf.append('hello');
    buf.append(' world');
    expect(buf.getContent()).toBe('hello world');
  });

  it('超过 8KB 只保留最后 8KB', () => {
    const buf = new StderrRingBuffer();
    const chunk = 'x'.repeat(5000);
    buf.append(chunk); // 5000
    buf.append(chunk); // 10000
    const content = buf.getContent();
    expect(content.length).toBe(8192); // 8KB
  });

  it('getErrorDetail 返回最后 500 字符并脱敏', () => {
    const buf = new StderrRingBuffer();
    buf.append('a'.repeat(400) + 'sk-ant-api03-secret123' + 'b'.repeat(100));
    const detail = buf.getErrorDetail();
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail).not.toContain('sk-ant-api03-secret123');
    expect(detail).toContain('sk-ant-***');
  });
});

// ---- buildTerminalFrame ----

describe('buildTerminalFrame', () => {
  it('messageCount > 0 → success', () => {
    const buf = new StderrRingBuffer();
    const frame = buildTerminalFrame(3, buf, null, 5000);
    expect(frame.status).toBe('success');
    expect('error_class' in frame).toBe(false);
  });

  it('messageCount 0 + 401 stderr → error with auth_error', () => {
    const buf = new StderrRingBuffer();
    buf.append('Error: 401 Unauthorized');
    const frame = buildTerminalFrame(0, buf, null, 3000);
    expect(frame.status).toBe('error');
    if (frame.status === 'error') {
      expect(frame.error_class).toBe('auth_error');
      expect(frame.duration_ms).toBe(3000);
      expect(frame.exit_code).toBeNull();
    }
  });

  it('messageCount 0 + exit code 1 无关键词 → cli_crash', () => {
    const buf = new StderrRingBuffer();
    buf.append('segfault');
    const frame = buildTerminalFrame(0, buf, 1, 2000);
    if (frame.status === 'error') {
      expect(frame.error_class).toBe('cli_crash');
    }
  });
});
