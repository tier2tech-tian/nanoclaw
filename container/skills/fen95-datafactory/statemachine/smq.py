#!/usr/bin/env python3
"""95分 业务状态机查询（给 agent / 人用）。数据来自同目录 fen95_state_machine.json（由 build_sm.py 生成）。

  smq.py graphs                         三张图概览
  smq.py nodes <graph>                  列状态
  smq.py node <graph> <status>          状态详情：App 文案、进边/出边、能到它的配方
  smq.py edge <edge_id>                 边详情
  smq.py path <graph> <from> <to> [类型]  最短推进路径（from 可写 new 表示从创建开始；类型 寄售/挂售/拍卖，seller 默认寄售）
  smq.py how <graph> <status> [rid] [类型] 要造"某状态"的单：路径 + 每步谁推/工厂场景/配方 + 品类注意
  smq.py search <关键词>                 在名称/动作/文案/配方里找
  smq.py couplings                      三图耦合边
  加 --json 输出机器可读。
"""
import json, sys, pathlib, re
from collections import deque

DATA = json.loads(pathlib.Path(__file__).with_name("fen95_state_machine.json").read_text(encoding="utf-8"))
G = DATA["graphs"]
JSON = "--json" in sys.argv
argv = [a for a in sys.argv[1:] if a != "--json"]

def all_nodes(g): return list(G[g]["nodes"].keys())
def from_set(g, e):
    f = e["from"]
    if f is None: return {"new"}
    if f.startswith("{非"):
        ex = set(re.findall(r"\d+", f)); return {n for n in all_nodes(g) if n not in ex}
    if f.startswith("{"): return set(re.findall(r"\d+", f))
    return {x.strip() for x in f.split("|")}
def to_set(e):
    """to 可写 "8|2"（任一）或 "13→14→15"（链，链上每个状态都算该边能到达）。"""
    out = set()
    for part in e["to"].split("|"):
        for n in part.split("→"): out.add(n.strip())
    return out
def edges(g): return G[g]["edges"]
def find_edge(eid):
    for g in G:
        for e in edges(g):
            if e["id"].lower() == eid.lower(): return e
def node_name(g, n): return "创建" if n == "new" else f'{n} {G[g]["nodes"].get(n, {}).get("name", "?")}'
def fmt_edge(e, g=None):
    g = g or e["graph"]
    s = f'[{e["id"]}] {node_name(g, (e["from"] or "new").split("|")[0]) if e["from"] in (None,) else e["from"]} → {e["to"]}  {e["action"]}\n'
    s += f'   谁推: {e["who"]} | 证据: {e["evidence"]} | 类别: {e["kind"]}'
    if e["sale_types"]: s += f' | 类型: {"/".join(e["sale_types"])}'
    s += "\n"
    if e["precondition"]: s += f'   前置: {e["precondition"]}\n'
    s += f'   实现: {e["impl"]}\n'
    if e["entry"]: s += f'   入口: {e["entry"]}\n'
    if e["app_view"]: s += f'   App 看到: {e["app_view"]}\n'
    if e["category_params"]: s += f'   品类分支: {", ".join(e["category_params"])}\n'
    if e["factory"]: s += f'   工厂: ' + " ; ".join(e["factory"]) + "\n"
    if e["recipes"]: s += f'   配方: {", ".join(e["recipes"])}\n'
    if e["coupling"]: s += f'   耦合: {e["coupling"]}\n'
    if e["notes"]: s += f'   注意: {e["notes"]}\n'
    return s

def usable(e, stype, bypass=False):
    """默认只用 kind=normal 的边；bypass=True 时允许旁路创建边。rollback 边永远不进路径搜索。"""
    if e["kind"] == "rollback": return False
    if e["kind"] == "bypass" and not bypass: return False
    return not stype or not e["sale_types"] or stype in e["sale_types"]
def shortest_path(g, src, dst, stype=None):
    """BFS，边可从 from_set 任一到 to_set 任一；创建边 from=new；stype 过滤 sale_types（寄售/挂售/拍卖）。"""
    q = deque([(src, [])]); seen = {src}
    while q:
        cur, path = q.popleft()
        if cur == dst: return path
        for e in edges(g):
            if usable(e, stype) and cur in from_set(g, e):
                for t in to_set(e):
                    if t not in seen:
                        seen.add(t); q.append((t, path + [e]))
    return None

def cmd_graphs():
    for g, v in G.items():
        print(f'{g}: {v["title"]}  状态 {len(v["nodes"])} 边 {len(v["edges"])}  表 {v["meta"].get("table","")}')
def cmd_nodes(g):
    for n, v in G[g]["nodes"].items():
        print(f'{n:>3} {v["name"]}' + (f'  App: {"; ".join(v["app_sub"])}' if v.get("app_sub") else ""))
def cmd_node(g, n):
    v = G[g]["nodes"].get(n)
    if not v: sys.exit(f"无此状态 {g}/{n}")
    ins = [e for e in edges(g) if n in to_set(e)]; outs = [e for e in edges(g) if n in from_set(g, e)]
    if JSON: print(json.dumps({"node": n, **v, "in": ins, "out": outs}, ensure_ascii=False, indent=1)); return
    print(f'{g} {n} {v["name"]}'); 
    for k in ("enum", "app_sub", "notes"):
        if v.get(k): print(f'  {k}: {v[k]}')
    print("进边:"); [print("  " + fmt_edge(e, g)) for e in ins]
    print("出边:"); [print("  " + fmt_edge(e, g)) for e in outs]
def cmd_edge(eid):
    e = find_edge(eid) or sys.exit(f"无此边 {eid}")
    print(json.dumps(e, ensure_ascii=False, indent=1) if JSON else fmt_edge(e))
def default_type(g, stype): return stype or ("寄售" if g == "seller" else None)
def cmd_path(g, a, b, stype=None):
    a = "new" if a in ("new", "创建", "无") else a
    stype = default_type(g, stype); p = shortest_path(g, a, b, stype)
    if p is None: sys.exit(f"{g}: {a} 到 {b} 无路径" + (f"（类型 {stype}；本图未抽该类型的创建边，或只能旁路创建，看 X* 边）" if stype else "（可能只能旁路创建，看 X* 边）"))
    if JSON: print(json.dumps(p, ensure_ascii=False, indent=1)); return
    print(f'{g}: {node_name(g,a)} → {node_name(g,b)}' + (f'（{stype}）' if stype else "") + f'，{len(p)} 步')
    for i, e in enumerate(p, 1): print(f'{i}. ' + fmt_edge(e, g))
def cmd_how(g, n, rid=None, stype=None):
    stype = default_type(g, stype); p = shortest_path(g, "new", n, stype)
    cat = DATA["categories"].get(rid, rid) if rid else None
    hits = [cp for cp in DATA["category_params"] if rid and (re.search(rf"(?<![\w童])({re.escape(cat)})", cp["effect"] + cp["decided_by"]) or re.search(rf"品类 {rid}(?!\d)", cp["decided_by"]))]
    direct = [e for e in edges(g) if n in to_set(e) and e["from"] is None and e["kind"] == "bypass" and usable(e, stype, True)]
    if JSON: print(json.dumps({"target": n, "path": p, "bypass_create": direct, "category_notes": hits, "factory": DATA["factory"]}, ensure_ascii=False, indent=1)); return
    print(f'目标：{g} {node_name(g,n)}' + (f'（{stype}）' if stype else "") + (f'（品类 {rid} {cat}）' if rid else ""))
    print("工厂规则：" + DATA["factory"]["rule_new_vs_existing"])
    if direct: print("可旁路直接创建成该状态：" + " ; ".join(f'{e["id"]} {e["action"]}' for e in direct))
    if p:
        print(f"正常推进 {len(p)} 步：")
        for i, e in enumerate(p, 1):
            print(f' {i}. {e["id"]} {e["from"] or "创建"}→{e["to"]} {e["action"]}｜谁推 {e["who"]}' + (f'｜前置 {e["precondition"]}' if e["precondition"] else "") + f'｜工厂 {" / ".join(e["factory"]) or "无"}｜配方 {", ".join(e["recipes"]) or "无"}' + (f'｜注意 {e["notes"]}' if e["notes"] else ""))
    else: print("无从创建出发的正常路径")
    for cp in hits: print(f'品类注意：{cp["name"]} — {cp["effect"]}（{cp["src"]}）' + (f'；造数 {cp["factory"]}' if cp.get("factory") else ""))
    print("策略：" + " → ".join(DATA["factory"]["policy"]))
def cmd_search(kw):
    kw = kw.lower()
    for g in G:
        for n, v in G[g]["nodes"].items():
            blob = json.dumps(v, ensure_ascii=False).lower()
            if kw in blob: print(f'节点 {g}/{n} {v["name"]}')
        for e in edges(g):
            if kw in json.dumps(e, ensure_ascii=False).lower(): print(f'边 {e["id"]} {e["from"]}→{e["to"]} {e["action"]}')
    for cp in DATA["category_params"]:
        if kw in json.dumps(cp, ensure_ascii=False).lower(): print(f'品类分支 {cp["name"]}: {cp["effect"]}')
def cmd_couplings():
    print(json.dumps(DATA["couplings"], ensure_ascii=False, indent=1) if JSON else "\n".join(f'{c["name"]}: ' + " | ".join(f'{k} {v}' for k, v in c.items() if k not in ("name","edges")) + f'  边 {",".join(c["edges"])}' for c in DATA["couplings"]))

if not argv: print(__doc__); sys.exit(0)
cmd, *rest = argv
{"graphs": cmd_graphs, "nodes": cmd_nodes, "node": cmd_node, "edge": cmd_edge, "path": cmd_path, "how": cmd_how, "search": cmd_search, "couplings": cmd_couplings}[cmd](*rest)
