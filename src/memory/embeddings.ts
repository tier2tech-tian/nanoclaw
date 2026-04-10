/**
 * Embedding 生成模块 — 从 Nine embeddings.py 翻译
 *
 * 使用 DashScope text-embedding-v4（1024 维），通过 OpenAI 兼容 API。
 */
import OpenAI from 'openai';

import { getMemoryConfig } from './config.js';
import { logger } from '../logger.js';

let _client: OpenAI | null = null;

// embedding LRU 缓存（按 query text → 向量，最多 128 条）
const EMBEDDING_CACHE_MAX = 128;
const _embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const val = _embeddingCache.get(key);
  if (val) {
    // LRU: 移到末尾
    _embeddingCache.delete(key);
    _embeddingCache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, val: number[]): void {
  if (_embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    // 淘汰最旧的（Map 头部）
    const oldest = _embeddingCache.keys().next().value;
    if (oldest !== undefined) _embeddingCache.delete(oldest);
  }
  _embeddingCache.set(key, val);
}

function getClient(): OpenAI {
  if (_client) return _client;
  const config = getMemoryConfig();
  _client = new OpenAI({
    apiKey: config.dashscopeApiKey,
    baseURL: config.dashscopeBaseUrl,
  });
  return _client;
}

/** 重置客户端（测试用） */
export function resetEmbeddingClient(): void {
  _client = null;
}

/**
 * 获取文本的 embedding 向量。
 * API 失败时返回 null。
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!text || !text.trim()) {
    logger.warn('getEmbedding 收到空文本，返回 null');
    return null;
  }

  // LRU 缓存命中
  const trimmed = text.trim();
  const cached = cacheGet(trimmed);
  if (cached) return cached;

  try {
    const config = getMemoryConfig();
    const client = getClient();
    const response = await client.embeddings.create({
      model: config.embeddingModel,
      input: trimmed,
    });
    const embedding = response.data[0].embedding;
    cacheSet(trimmed, embedding);
    return embedding;
  } catch (err) {
    logger.warn({ err }, 'Embedding 生成失败');
    return null;
  }
}

/**
 * 计算两个向量的余弦相似度，范围 [-1, 1]。
 * 零向量返回 0。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * 将 number[] 序列化为 Buffer（Float32Array）以存入 SQLite BLOB。
 */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/**
 * 从 SQLite BLOB (Buffer) 反序列化为 number[]。
 */
export function bufferToEmbedding(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}
