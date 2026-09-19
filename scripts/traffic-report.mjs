#!/usr/bin/env node
/** 读 traffic-log 出报表：按目标域名 / 按进程 聚合走代理的流量 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = '/Users/dajay/AI_Workspace/nanoclaw/data/traffic-log';
const day = process.argv[2] || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const f = join(DIR, `flow-${day}.jsonl`);
if (!existsSync(f)) {
  console.log(`无数据: ${f}`);
  console.log('可用:', readdirSync(DIR).filter(x => x.startsWith('flow-')).join(' '));
  process.exit(0);
}
const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const mb = (b) => b / 1048576;
const agg = (keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const a = m.get(k) || { up: 0, dn: 0, n: 0 };
    a.up += r.up; a.dn += r.dn; a.n++;
    m.set(k, a);
  }
  return [...m.entries()].sort((x, y) => (y[1].up + y[1].dn) - (x[1].up + x[1].dn));
};
const tot = rows.reduce((s, r) => s + r.up + r.dn, 0);
console.log(`日期 ${day}   连接 ${rows.length} 条   走代理总流量 ${mb(tot).toFixed(2)} MB\n`);
for (const [title, fn] of [['按目标', r => r.host], ['按进程', r => r.proc], ['按规则链', r => r.chain]]) {
  console.log(`=== ${title} TOP10 ===`);
  for (const [k, a] of agg(fn).slice(0, 10)) {
    const pct = ((a.up + a.dn) / tot * 100).toFixed(1);
    console.log(`  ${String(k).slice(0, 46).padEnd(46)} ↑${mb(a.up).toFixed(1).padStart(8)}MB ↓${mb(a.dn).toFixed(1).padStart(8)}MB  ${pct.padStart(5)}%  n=${a.n}`);
  }
  console.log('');
}
