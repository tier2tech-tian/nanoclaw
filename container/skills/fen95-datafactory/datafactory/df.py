#!/usr/bin/env python3
"""造数工厂直调：df.py <supply|trade> <path> <json body>  （手机号从 ~/mock95/.df_creds 读，输出打码）"""
import sys,json,subprocess,re,time
BASE={"supply":"http://10.217.8.230:8084","trade":"http://10.217.8.230:8096"}
svc,path,body=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])
creds={k:open(f"/Users/admin/mock95/.df_creds/{k}").read().strip() for k in ("seller_mobile_main","seller_mobile_z3")}
def sub(o):
    if isinstance(o,str): return creds.get(o,o)
    if isinstance(o,dict): return {k:sub(v) for k,v in o.items()}
    if isinstance(o,list): return [sub(v) for v in o]
    return o
body=sub(body); t0=time.time()
r=subprocess.run(["curl","-s","--noproxy","*","-m",str(int(sys.argv[4]) if len(sys.argv)>4 else 180),"-X","POST",BASE[svc]+path,"-H","Content-Type: application/json","-H","autotest: yes","-H","dataSourceType: t1","-H","X-Datafactory-Caller: dagou","-d",json.dumps(body,ensure_ascii=False)],capture_output=True,text=True)
out=r.stdout.strip() or f"<empty stdout, rc={r.returncode}, stderr={r.stderr[:200]}>"
out=re.sub(r"(?<!\d)1[3-9]\d{9}(?!\d)","1**********",out)
print(f"[{svc}{path} {time.time()-t0:.1f}s]"); print(out[:1500])
