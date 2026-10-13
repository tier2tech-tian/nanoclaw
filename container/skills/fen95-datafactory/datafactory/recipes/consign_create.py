#!/usr/bin/env python3
"""DataFactory 造数 CLI —— 通过 datafactory-mcp (SSE) 调用 Consign 相关 AllScene 场景造寄售单。
用法:
  python3 consign_create.py --rid 35 --code A2404 --scene JiShouAppSaveExpressController \
      --seller-mobile-file ~/.df_seller_mobile --env t1
凭据只从本地文件读（600权限），不写进任何日志/结果文件。
scene 可选值（DeliveryController.AllScene 分发）：
  JiShouAppSaveExpressController  创建+发货（不推进上架，最稳）
  JiShouOnSaleController          创建+发货+一检+定价上架（部分类目会在一检报错，见README已知坑）
  jiShouAddAndExpressAndOnself    创建+发货+一检上架（不定价）
  jiShouAddAndExpressAndPricingAndBuy  再加买家下单（消耗性，慎用）
rid 类目对照（DataFactoryCategoryCodePool，见 Consign.java 注释）：
  1鞋 26帽 35数码 72潮玩积木 25包袋 2服装 70珠宝/服装配置(cid区分) 71美妆 1011家居
"""
import argparse, json, subprocess, threading, time, urllib.request, sys, os

MCP_BASE = "http://10.217.8.230:8000"

def call_mcp(scenario_id, body, env="t1", timeout=60):
    sid_holder = {}
    lines = []
    def read_sse():
        p = subprocess.Popen(['curl','-sN','-m',str(timeout),f'{MCP_BASE}/sse','-H','Accept: text/event-stream'],
                              stdout=subprocess.PIPE, text=True)
        for line in p.stdout:
            lines.append(line)
            if 'session_id=' in line:
                sid_holder['sid'] = line.strip().split('session_id=')[1]
    t = threading.Thread(target=read_sse, daemon=True); t.start()
    time.sleep(2)
    sid = sid_holder.get('sid')
    if not sid:
        print("ERR: 拿不到 MCP session_id", file=sys.stderr); sys.exit(2)
    def post(payload):
        req = urllib.request.Request(f'{MCP_BASE}/messages/?session_id={sid}',
                                      data=json.dumps(payload).encode(),
                                      headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
    post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"consign_create_cli","version":"0.1"}}})
    time.sleep(1.5)
    post({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
    time.sleep(0.5)
    post({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"datafactory_run_scenario",
        "arguments":{"caller":"consign_create_cli","scenario_id":scenario_id,"env":env,"body":body}
    }})
    time.sleep(min(timeout-5, 50))
    raw = ''.join(lines)
    import re
    m = re.search(r'"id":2,"result":\{"content":\[\{"type":"text","text":"(.*?)"\}\],"structuredContent"', raw, re.S)
    if not m:
        print("ERR: 没拿到 tools/call 结果，原始SSE：", raw[-1000:], file=sys.stderr)
        sys.exit(2)
    text = m.group(1).encode().decode('unicode_escape')
    return json.loads(text)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rid', type=int, required=True)
    ap.add_argument('--code', default=None, help='货号，留空则按rid用DataFactoryCategoryCodePool默认值（务必留空以拿到正确类目默认货号，MCP schema的静态默认值只对rid=1准确）')
    ap.add_argument('--scene', default='JiShouAppSaveExpressController')
    ap.add_argument('--seller-mobile-file', required=True, help='本地600权限文件，内容为一行手机号')
    ap.add_argument('--env', default='t1', choices=['t1','t2'])
    a = ap.parse_args()

    mode = os.stat(a.seller_mobile_file).st_mode & 0o777
    if mode & 0o077:
        print(f"WARN: {a.seller_mobile_file} 权限过松({oct(mode)})，建议 chmod 600", file=sys.stderr)
    mobile = open(a.seller_mobile_file).read().strip()

    body = {"mobile": mobile, "rid": a.rid, "scene": a.scene}
    if a.code:
        body["code"] = a.code

    result = call_mcp("trade_post_api_trade_jishou_allscene", body, env=a.env)
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
