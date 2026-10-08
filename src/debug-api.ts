/**
 * 调试 HTTP API — 用于测试模型切换等功能
 * 端口 19877，仅 localhost 监听
 *
 * GET  /status                      — 进程状态
 * POST /send?jid=fs:oc_xxx&text=hello — 模拟发消息
 * GET  /logs?n=20                   — 最近 N 条日志
 * POST /meegle/dispatch             — 飞书项目回调派活给数字员工（JSON body）
 */
import http from 'http';
import { logger } from './logger.js';

const DEBUG_PORT = 19877;

interface DebugDeps {
  sendTestMessage: (jid: string, text: string) => Promise<string>;
  getStatus: () => Record<string, unknown>;
  meegleDispatch?: (
    body: Record<string, unknown>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body 须为 JSON 对象');
  }
  return parsed;
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

      if (
        url.pathname === '/meegle/dispatch' &&
        req.method === 'POST' &&
        deps.meegleDispatch
      ) {
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: String(err) }));
          return;
        }
        const result = await deps.meegleDispatch(body);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
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
