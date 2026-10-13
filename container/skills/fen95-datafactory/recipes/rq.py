#!/usr/bin/env python3
"""配方查询：rq.py <配方id> | find <关键词> | list [状态]   （读同目录 recipes.json，--json 给 agent 用）"""
import json,os,sys
d=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"recipes.json"),encoding="utf-8"))
R=d["recipes"]; byid={r["配方id"]:r for r in R if r.get("配方id")}
js="--json" in sys.argv; args=[a for a in sys.argv[1:] if a!="--json"]
def show(r):
    if js: print(json.dumps(r,ensure_ascii=False)); return
    print(f"## {r['配方id']}  状态={r.get('状态')}  方式={r.get('造数方式')}  环境={r.get('适用环境')}  端={r.get('适用端')}")
    for k in ("目标状态","数据对象","步骤","入口/场景码","前置配方","产出字段","验证方法","红线","已验证证据","造数备注","时效"):
        v=r.get(k)
        if v: print(f"  {k}: {v}")
if not args: print(__doc__); sys.exit()
if args[0]=="list":
    st=args[1] if len(args)>1 else None
    for r in R:
        if not st or st in str(r.get("状态")): print(r["配方id"],"|",r.get("状态"),"|",(r.get("目标状态") or "")[:40])
elif args[0]=="find":
    kw=args[1]
    for r in R:
        if kw in json.dumps(r,ensure_ascii=False): show(r)
else:
    r=byid.get(args[0]); print("没有这个配方 id") if not r else show(r)
