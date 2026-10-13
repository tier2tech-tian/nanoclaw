#!/usr/bin/env python3
"""寄售单状态推进 CLI —— 一条命令把寄售单造到指定终态。

用法:
  python3 consign_advance.py --rid 1 --to 已发货 --seller-mobile-file ~/mock95/.df_creds/seller_mobile_main
  python3 consign_advance.py --rid 25 --code SUP-SS18-691 --to 出售中 --seller-mobile-file ~/mock95/.df_creds/seller_mobile_main

--to 支持四档（2026-09-19 逐档实测坐实，见 fen95-flows README「DataFactory 造数 CLI」节）：
  已发货   trade 模块 allscene（JiShouAppSaveExpressController，走MCP env固定t1——MCP层只认t1/t2，传test1会被MCP直接拒绝），最稳，鞋/数码/箱包/珠宝均验证 status=2
  查验中   supply 模块 /api/jiShou/e2e execWarehousingServiceE2E，env固定t1，status=5
  待上架   supply 模块 /api/jiShou/e2e firstAuditE2EService，env固定t1，status=8（需要更长超时，实测约60~90s）
  出售中   supply 模块 /api/jiShou/e2e OnSaleService，env固定t1，status=0；鞋/箱包/服饰三类目实测通过

⚠️ 不支持"待发货"(1)/"已完成"(3)：2026-09-19 实测 waitCheckOutService/deliveryFinishService 两个
supply 场景调用均返回200成功、且确实写入了 trade_number/in_express_number 等关联字段，但
jiuwu_sellers_order.status 全程不推进。根因见 B①研究结论——真实状态机由 mothership ms-black
（黑光履约系统）消息队列驱动的物理仓储事件触发，任何 HTTP 造数接口都改不动这两个状态，此处不做假支持。

两个模块 env 取值口径不同，脚本内部已固定好，不接受用户覆盖：
  trade 模块（已发货）走 MCP，MCP 层只认 env=t1/t2（传 test1 会被 MCP 直接拒绝："env 仅允许 t1 或 t2"）
  supply 模块（其余三档）走直连 Java 服务，env=t1（写test1会拼出不存在的域名 test1-admin-api.95fenapp.com）

凭据只从本地 600 权限文件读，不写进任何日志/结果文件/参数默认值。
"""
import argparse
import json
import subprocess
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from consign_create import call_mcp  # 复用 trade allscene 的 MCP SSE 调用

SUPPLY_BASE = "http://10.217.8.230:8084/api/jiShou/e2e"

TO_SUPPLY_SCENE = {
    "查验中": "execWarehousingServiceE2E",
    "待上架": "firstAuditE2EService",
    "出售中": "OnSaleService",
}
TO_STATUS = {
    "已发货": 2,
    "查验中": 5,
    "待上架": 8,
    "出售中": 0,
}


def run_supply_scene(scene, mobile, rid, code, timeout):
    body = {"mobile": mobile, "rid": rid, "scene": scene, "env": "t1"}
    if code:
        body["code"] = code
    payload = json.dumps(body, ensure_ascii=False)
    cmd = [
        "curl", "-s", "-X", "POST", SUPPLY_BASE,
        "-H", "Content-Type: application/json",
        "-H", "dataSourceType: t1",
        "-H", "autotest: yes",
        "-d", payload,
        "-m", str(timeout),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    if not out.stdout.strip():
        print("ERR: supply 接口空响应（很可能是 -m 超时，深链路场景需要更长超时）", file=sys.stderr)
        sys.exit(2)
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rid", type=int, required=True)
    ap.add_argument("--code", default=None, help="货号，留空按rid取默认；非鞋类目建议先调 randomCode 拿一个再传")
    ap.add_argument("--to", required=True, choices=list(TO_STATUS.keys()))
    ap.add_argument("--seller-mobile-file", required=True)
    ap.add_argument("--timeout", type=int, default=90)
    a = ap.parse_args()

    mode = os.stat(a.seller_mobile_file).st_mode & 0o777
    if mode & 0o077:
        print(f"WARN: {a.seller_mobile_file} 权限过松({oct(mode)})，建议 chmod 600", file=sys.stderr)
    mobile = open(a.seller_mobile_file).read().strip()

    if a.to == "已发货":
        body = {"mobile": mobile, "rid": a.rid, "scene": "JiShouAppSaveExpressController"}
        if a.code:
            body["code"] = a.code
        result = call_mcp("trade_post_api_trade_jishou_allscene", body, env="t1", timeout=a.timeout)
    else:
        scene = TO_SUPPLY_SCENE[a.to]
        result = run_supply_scene(scene, mobile, a.rid, a.code, a.timeout)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"# 期望终态 status={TO_STATUS[a.to]}（{a.to}），请自行核库确认", file=sys.stderr)


if __name__ == "__main__":
    main()
