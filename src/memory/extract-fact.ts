/**
 * 轻量 LLM 标准化 — 单条内容 → 结构化 fact
 *
 * 用于 memory_remember 的阶段 2（异步精炼）。
 * 独立于 updater.ts 的重量级对话分析逻辑。
 */
import OpenAI from 'openai';

import { logger } from '../logger.js';
import { getMemoryConfig } from './config.js';
import { getEmbedding } from './embeddings.js';
import { updateFact } from './storage.js';

// 使用 system/user 分离，避免 prompt 注入
const SYSTEM_PROMPT = `你是记忆提取助手。给定用户要求记住的一段内容，提取一条精炼的结构化记忆。

规则：
- content: 精炼后的事实陈述，去除口语化表达
- category: 从 preference / knowledge / context / behavior / goal 中选一个
- confidence: 0.0-1.0，表示这条信息的确定程度

只输出 JSON，不要其他内容：
{"content": "...", "category": "...", "confidence": 0.0}`;

export async function extractFact(rawContent: string): Promise<{
  content: string;
  category: string;
  confidence: number;
}> {
  const config = getMemoryConfig();
  if (!config.dashscopeApiKey) {
    return { content: rawContent, category: 'context', confidence: 0.5 };
  }

  const client = new OpenAI({
    apiKey: config.dashscopeApiKey,
    baseURL: config.dashscopeBaseUrl,
  });

  try {
    const response = await client.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: rawContent },
      ],
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content || '';
    return JSON.parse(text);
  } catch (err) {
    logger.warn({ err }, 'LLM fact extraction failed');
    return { content: rawContent, category: 'context', confidence: 0.5 };
  }
}

/**
 * 异步精炼：LLM 标准化 + embedding 生成 → 回写 DB。
 * 失败时原文保留（阶段 1 的 storeFactRaw 已写入）。
 */
export async function extractAndRefine(
  factId: string,
  rawContent: string,
  _groupFolder: string,
): Promise<void> {
  // LLM 标准化
  const fact = await extractFact(rawContent);

  // 生成 embedding（用精炼后的内容）
  const embedding = await getEmbedding(fact.content);

  // 回写 DB
  updateFact(factId, {
    content: fact.content,
    category: fact.category,
    confidence: fact.confidence,
    embedding,
  });

  logger.info(
    { factId, refined: fact.content !== rawContent },
    'Fact refined by LLM',
  );
}
