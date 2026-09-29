#!/usr/bin/env node
/** 本机流量报表：区分「走代理(消耗 BWG)」与「直连(不消耗)」 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = '/Users/dajay/AI_Workspace/nanoclaw/data/traffic-log';
const day = process.argv[2] || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const f = join(DIR, `flow-${day}.jsonl`);
if (!existsSync(f)) {
  console.log(`无数据: ${f}`);
  console.log('可用:', readdirSync(DIR).filter(x => x.startsWith('flow-')).map(x => x.slice(5, 15)).join(' '));
  process.exit(0);
}
const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const G = 1073741824, M = 1048576;
const fmt = (b) => b >= G ? `${(b / G).toFixed(2)}G` : `${(b / M).toFixed(1)}M`;

// 老格式没有 px 字段，按 chain 回退判断
const isPx = (r) => r.px !== undefined ? r.px : /vless|vmess|trojan/i.test(r.chain || '');

const px = rows.filter(isPx), dr = rows.filter(r => !isPx(r));
const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);

console.log(`日期 ${day}   连接 ${rows.length} 条\n`);
console.log('┌─ 总览 ───────────────────────────────────────────');
for (const [label, arr] of [['走代理(耗 BWG)', px], ['直  连(不耗)', dr]]) {
  const u = sum(arr, 'up'), d = sum(arr, 'dn');
  console.log(`│ ${label}  ↑${fmt(u).padStart(8)}  ↓${fmt(d).padStart(8)}  合计${fmt(u + d).padStart(9)}  n=${arr.length}`);
}
console.log('└──────────────────────────────────────────────────\n');

const agg = (arr, keyFn, top = 8) => {
  const m = new Map();
  for (const r of arr) {
    const k = keyFn(r) || '?';
    const a = m.get(k) || { up: 0, dn: 0, n: 0 };
    a.up += r.up; a.dn += r.dn; a.n++;
    m.set(k, a);
  }
  return [...m.entries()].sort((x, y) => (y[1].up + y[1].dn) - (x[1].up + x[1].dn)).slice(0, top);
};

for (const [title, arr] of [['走代理', px], ['直连', dr]]) {
  if (!arr.length) continue;
  const tot = sum(arr, 'up') + sum(arr, 'dn');
  console.log(`=== ${title} · 按目标 TOP8 ===`);
  for (const [k, a] of agg(arr, r => r.host)) {
    const pct = ((a.up + a.dn) / tot * 100).toFixed(1);
    console.log(`  ${String(k).slice(0, 40).padEnd(40)} ↑${fmt(a.up).padStart(8)} ↓${fmt(a.dn).padStart(8)} ${pct.padStart(5)}% n=${a.n}`);
  }
  console.log(`=== ${title} · 按进程 TOP5 ===`);
  for (const [k, a] of agg(arr, r => r.proc, 5)) {
    const pct = ((a.up + a.dn) / tot * 100).toFixed(1);
    console.log(`  ${String(k).slice(0, 40).padEnd(40)} ↑${fmt(a.up).padStart(8)} ↓${fmt(a.dn).padStart(8)} ${pct.padStart(5)}%`);
  }
  console.log('');
}

// 网卡对账
const nf = join(DIR, `nic-${day}.jsonl`);
if (existsSync(nf)) {
  const n = readFileSync(nf, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (n.length >= 2) {
    const rx = n[n.length - 1].rx - n[0].rx, tx = n[n.length - 1].tx - n[0].tx;
    const clash = sum(rows, 'up') + sum(rows, 'dn');
    console.log('=== 网卡对账（en1）===');
    console.log(`  网卡实测  ↓${fmt(rx)} ↑${fmt(tx)}  合计 ${fmt(rx + tx)}`);
    console.log(`  Clash 记录            合计 ${fmt(clash)}`);
    console.log(`  差额(未走 Clash)      ${fmt(Math.max(0, rx + tx - clash))}`);
  }
}
