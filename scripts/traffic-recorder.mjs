#!/usr/bin/env node
/**
 * 本机流量记录器 —— 高频采样 Clash /connections，按连接 ID 累计字节。
 *
 * 解决的问题：/connections 只返回当前活跃连接，短连接（API 调用几秒就结束）
 * 在低频采样下会整段丢失，导致流量归因永远对不上。这里 2 秒采一次并记住每个
 * 连接 ID 的最新累计值，连接消失时结算落盘，做到不漏。
 */
import { request } from 'http';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SOCK = '/tmp/verge/verge-mihomo.sock';
const OUT_DIR = '/Users/dajay/AI_Workspace/nanoclaw/data/traffic-log';
const INTERVAL = 2000;
mkdirSync(OUT_DIR, { recursive: true });

const live = new Map(); // id -> {host, process, chain, up, dn, start}

function fetchConns() {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCK, path: '/connections', method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function dayFile() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  return join(OUT_DIR, `flow-${d.toISOString().slice(0, 10)}.jsonl`);
}

function settle(id, c) {
  // 只记走代理的连接；DIRECT 不消耗 BWG 流量
  if (!c.chain.includes('vless') && !c.chain.includes('VLESS') && !c.chain.includes('VMess')) return;
  if (c.up + c.dn < 1024) return; // 忽略 1KB 以下噪音
  appendFileSync(dayFile(), JSON.stringify({
    t: new Date().toISOString(),
    host: c.host, proc: c.process, chain: c.chain,
    up: c.up, dn: c.dn, dur: Math.round((Date.now() - c.start) / 1000),
  }) + '\n');
}

async function tick() {
  let data;
  try { data = await fetchConns(); } catch { return; }
  const seen = new Set();
  for (const c of data.connections || []) {
    const m = c.metadata || {};
    seen.add(c.id);
    live.set(c.id, {
      host: m.host || m.destinationIP || '?',
      process: m.process || '?',
      chain: (c.chains || []).join(' > '),
      up: c.upload || 0, dn: c.download || 0,
      start: live.get(c.id)?.start ?? Date.now(),
    });
  }
  // 已消失的连接 → 结算
  for (const [id, c] of live) {
    if (!seen.has(id)) { settle(id, c); live.delete(id); }
  }
}

console.log(`[traffic-recorder] started, sampling every ${INTERVAL}ms → ${OUT_DIR}`);
setInterval(tick, INTERVAL);
tick();

// 退出前把还活着的连接也结算掉
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const [id, c] of live) settle(id, c); process.exit(0); });
}
