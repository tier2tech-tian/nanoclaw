/**
 * 调试 HTTP API — 用于测试模型切换等功能
 * 端口 19877，仅 localhost 监听
 *
 * GET  /status                      — 进程状态
 * POST /send?jid=fs:oc_xxx&text=hello — 模拟发消息
 * GET  /logs?n=20                   — 最近 N 条日志
 */
import http from 'http';
import { logger } from './logger.js';

const DEBUG_PORT = 19877;

interface DebugDeps {
  sendTestMessage: (jid: string, text: string) => Promise<string>;
  getStatus: () => Record<string, unknown>;
}

export function startDebugApi(deps: DebugDeps): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${DEBUG_PORT}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      if (url.pathname === '/status') {
        res.end(JSON.stringify(deps.getStatus(), null, 2));
        return;
      }

      if (url.pathname === '/send' && req.method === 'POST') {
        const jid = url.searchParams.get('jid') || '';
        const text = url.searchParams.get('text') || '';
        if (!jid || !text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'missing jid or text' }));
          return;
        }
        const result = await deps.sendTestMessage(jid, text);
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(DEBUG_PORT, '127.0.0.1', () => {
    logger.info({ port: DEBUG_PORT }, 'Debug API started');
  });

  server.on('error', () => {
    // 端口冲突时不影响主流程
  });
}
