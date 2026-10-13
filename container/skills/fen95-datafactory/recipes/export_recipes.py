#!/usr/bin/env python3
"""把飞书多维表格「配方表」导成 recipes.json（agent 直接读）。
用法：python3 export_recipes.py [raw.json]   不传参数就现场用 lark-cli 拉（需本机 lark-cli 已登录）。
表：base EKYmbTQ4za4UbJsS2t5cQ4aknuh / table tblrZVesFOvjpDpM（维护入口仍是表，这里只是导出）。"""
import json,subprocess,sys,os,datetime
BASE="EKYmbTQ4za4UbJsS2t5cQ4aknuh"; TABLE="tblrZVesFOvjpDpM"
here=os.path.dirname(os.path.abspath(__file__))
if len(sys.argv)>1:
    raw=json.load(open(sys.argv[1]))
else:
    r=subprocess.run(["lark-cli","base","+record-list","--base-token",BASE,"--table-id",TABLE,"--page-size","100","--format","json"],capture_output=True,text=True,env={**os.environ,"LARK_CLI_NO_PROXY":"1"})
    raw=json.loads(r.stdout[r.stdout.index("{"):])
assert raw.get("ok"), raw.get("error")
d=raw["data"]; fields=d["fields"]; types=d["field_type_list"]
def norm(v,t):
    if v is None: return None
    if t=="link": return [x.get("id") if isinstance(x,dict) else x for x in v]
    if t=="attachment": return [x.get("name") or x.get("file_token") for x in v] if isinstance(v,list) else v
    if isinstance(v,list) and v and isinstance(v[0],dict) and "text" in v[0]: return "".join(x.get("text","") for x in v)
    return v
rows=[]
for rid,row in zip(d["record_id_list"],d["data"]):
    o={"record_id":rid}
    for f,t,v in zip(fields,types,row): o[f]=norm(v,t)
    rows.append(o)
assert not d.get("has_more"), "超过一页，需要分页"
out={"source":f"feishu base {BASE} table {TABLE}","exported_at":datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),"rev":d.get("rev"),"count":len(rows),"fields":fields,"recipes":rows}
json.dump(out,open(os.path.join(here,"recipes.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
print("recipes.json",len(rows),"条 rev",d.get("rev"))
