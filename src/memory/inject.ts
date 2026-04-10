/**
 * 记忆注入模块 — 将记忆格式化后写入 group 目录的 CLAUDE.md
 *
 * 使用 HTML 注释标记 <!-- nanoclaw:memory:start/end --> 包裹，
 * 避免与用户手写内容冲突。
 */
import fs from 'fs';
import path from 'path';

import { getMemoryConfig } from './config.js';
import { loadFacts, loadProfile } from './storage.js';
import { formatMemoryForInjection } from './prompt.js';
import { MemoryStore } from './memory-store.js';
import { logger } from '../logger.js';

const MEMORY_START = '<!-- nanoclaw:memory:start -->';
const MEMORY_END = '<!-- nanoclaw:memory:end -->';

/**
 * 将记忆注入 group 目录的 CLAUDE.md。
 *
 * R15 改造：
 * - profile 全量注入
 * - facts 走 MemoryStore.recall(latestUserMessage) 双路召回 top-K
 * - latestUserMessage 为空时 fallback 到全量注入
 */
export async function injectMemory(
  groupFolder: string,
  groupDir: string,
  latestUserMessage?: string,
  userId: string = '',
): Promise<void> {
  const config = getMemoryConfig();
  if (!config.injectionEnabled) return;

  // 整库查：不过滤 group_folder 和 user_id
  const profile = loadProfile();
  const allFacts = loadFacts();

  // 没有记忆数据时不操作
  if (!profile && allFacts.length === 0) return;

  // 决定使用哪些 facts
  let factsForInjection: Array<{
    id?: string;
    content: string;
    category: string;
    confidence: number;
  }>;

  const TOP_K = 10;

  if (latestUserMessage && allFacts.length > 0) {
    // 双路召回 top-K
    try {
      const store = new MemoryStore();
      const recalled = await store.recall(latestUserMessage, TOP_K);
      factsForInjection = recalled.map((r) => ({
        id: r.id,
        content: r.content,
        category:
          (r.metadata as Record<string, string> | null)?.category || 'context',
        confidence: r.score,
      }));
    } catch (err) {
      logger.warn({ err }, '双路召回失败，回退 confidence top-K');
      factsForInjection = allFacts.slice(0, TOP_K);
    }
  } else {
    // 无消息时按 confidence 取 top-K（allFacts 已按 confidence DESC 排序）
    factsForInjection = allFacts.slice(0, TOP_K);
  }

  // Wiki index 关键词匹配：从 global/wiki/index.md 提取相关条目
  let wikiHints = '';
  if (latestUserMessage) {
    try {
      const wikiIndexPath = path.join(groupDir, '..', 'global', 'wiki', 'index.md');
      if (fs.existsSync(wikiIndexPath)) {
        const indexContent = fs.readFileSync(wikiIndexPath, 'utf-8');
        // 提取所有 "- [xxx](yyy) — zzz" 行
        const entryRegex = /^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.+))?$/gm;
        const entries: Array<{ title: string; path: string; desc: string }> = [];
        let match: RegExpExecArray | null;
        while ((match = entryRegex.exec(indexContent)) !== null) {
          entries.push({ title: match[1], path: match[2], desc: match[3] || '' });
        }
        // 从用户消息提取关键词（中文字符 + 英文单词）
        const tokens = (latestUserMessage.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]\w{2,}/g) || [])
          .map(t => t.toLowerCase());
        if (tokens.length > 0) {
          const matched = entries.filter(e => {
            const text = `${e.title} ${e.desc}`.toLowerCase();
            return tokens.some(t => text.includes(t));
          }).slice(0, 5);
          if (matched.length > 0) {
            const lines = matched.map(e =>
              `- [${e.title}](../../global/wiki/${e.path})${e.desc ? ' — ' + e.desc : ''}`
            );
            wikiHints = '\nWiki 相关条目（需要时可用 Read 工具查看详情）：\n' + lines.join('\n');
            logger.info({ matched: matched.length, tokens: tokens.slice(0, 5) }, '[wiki] 命中 wiki 条目');
          }
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Wiki index 匹配失败（非致命）');
    }
  }

  // 组装 memoryData
  const memoryData = {
    user: (profile?.user as Record<string, unknown>) || undefined,
    history: (profile?.history as Record<string, unknown>) || undefined,
    facts: factsForInjection,
  };

  const memoryText = formatMemoryForInjection(memoryData);
  if (!memoryText && !wikiHints) return;

  // 写入 CLAUDE.md
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const memoryBlock = `${MEMORY_START}\n## Memory\n\n${memoryText || ''}${wikiHints ? '\n' + wikiHints + '\n' : '\n'}${MEMORY_END}`;

  let content: string;
  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf-8');

    // 检查是否已有 Memory section
    const startIdx = content.indexOf(MEMORY_START);
    const endIdx = content.indexOf(MEMORY_END);

    if (startIdx !== -1 && endIdx !== -1) {
      // 替换已有内容
      content =
        content.slice(0, startIdx) +
        memoryBlock +
        content.slice(endIdx + MEMORY_END.length);
    } else {
      // 追加到文件末尾
      content = content.trimEnd() + '\n\n' + memoryBlock + '\n';
    }
  } else {
    content = memoryBlock + '\n';
  }

  fs.writeFileSync(claudeMdPath, content);
  logger.info(
    { groupFolder, factsCount: factsForInjection.length },
    '记忆已注入 CLAUDE.md',
  );
}
