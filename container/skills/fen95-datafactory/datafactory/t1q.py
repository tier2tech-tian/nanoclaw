#!/usr/bin/env python3
"""T1 终态核验：t1q.py seller <order_number|goods_id> | recycle <sn> | buyer <order_number>"""
import sys,os,yaml,pymysql
MS=os.path.expanduser(os.environ.get("MOTHERSHIP_DIR","~/code/mothership/server"))
CRED_DIR=os.path.expanduser(os.environ.get("DF_CREDS_DIR","~/mock95/.df_creds"))
def conn(db):
    # 优先环境变量 T1_DB_DSN=user:pass@host:port（测试库只读串），否则从本机 mothership 源码的 conf.t1.yaml 取
    dsn=os.environ.get("T1_DB_DSN")
    if dsn:
        up,hp=dsn.rsplit("@",1); u,pw=up.split(":",1); h,pt=(hp.split(":")+["3306"])[:2]
        return pymysql.connect(host=h,port=int(pt),user=u,password=pw,database=db,connect_timeout=5)
    y=yaml.safe_load(open(f"{MS}/order/ms-goods-order/internal/conf/conf.t1.yaml")) if db!="ss_commodity" else None
    if db=="ss_commodity":
        import glob
        for f in glob.glob(f"{MS}/product/ms-recycle/**/conf*t1*.y*ml",recursive=True):
            d=yaml.safe_load(open(f))
            def walk(o):
                if isinstance(o,dict):
                    if o.get("database")=="ss_commodity" and (o.get("server") or o.get("host")): yield o
                    for v in o.values(): yield from walk(v)
                elif isinstance(o,list):
                    for v in o: yield from walk(v)
            for o in walk(d): return pymysql.connect(host=o.get("server") or o.get("host"),port=int(o.get("port",3306)),user=o["user"],password=str(o["password"]),database=db,connect_timeout=5)
    def find(o):
        if isinstance(o,dict):
            if o.get("database")=="trade_jiuwu" and o.get("server"): return o
            for v in o.values():
                r=find(v)
                if r: return r
        if isinstance(o,list):
            for v in o:
                r=find(v)
                if r: return r
    o=find(y); return pymysql.connect(host=o["server"],port=int(o["port"]),user=o["user"],password=str(o["password"]),database="trade_jiuwu",connect_timeout=5)
kind,key=sys.argv[1],sys.argv[2]
if kind=="seller":
    c=conn("trade_jiuwu"); cur=c.cursor()
    cur.execute("select o.order_number,o.goods_id,o.status,o.sale_type,o.uid,a.audit_status,g.status gs,g.audit_status gas,g.root_category_id,o.updated_at from jiuwu_sellers_order o left join jiuwu_sellers_order_attr a on a.order_number=o.order_number left join jiuwu_goods g on g.id=o.goods_id where o.order_number=%s or o.goods_id=%s order by o.id desc limit 3",(key,key))
    for r in cur.fetchall(): print("seller:",dict(zip(["order_number","goods_id","status","sale_type","uid","attr.audit","goods.status","goods.audit","rid","updated"],r)))
    cur.execute("select node_code,node_time from jiuwu_order_trace_node where order_number=%s and is_deleted=0 order by node_time desc limit 5",(key,)); print("trace:",cur.fetchall())
elif kind=="recycle":
    c=conn("trade_jiuwu"); cur=c.cursor()
    cur.execute("select sn,status,appraiser_status,updated_at from jiuwu_recycle_appraiser_order where sn=%s or sell_order_number=%s order by id desc limit 3",(key,key))
    for r in cur.fetchall(): print("recycle:",r)
    c2=conn("ss_commodity"); cur=c2.cursor()
    cur.execute("select old_status,new_status,operation_info,created_at from jiuwu_recycle_order_status_history where sn=%s order by id desc limit 8",(key,)); print("history:",cur.fetchall())
elif kind=="buyer":
    c=conn("trade_jiuwu"); cur=c.cursor()
    cur.execute("select order_number,goods_id,status,uid,updated_at from jiuwu_buyers_order where order_number=%s limit 1",(key,)); print("buyer:",cur.fetchone())
    cur.execute("select node_code,node_time from jiuwu_order_trace_node where order_number=%s and is_deleted=0 order by node_time desc limit 6",(key,)); print("trace:",cur.fetchall())
elif kind=="latest":
    c=conn("trade_jiuwu"); cur=c.cursor()
    mobile=os.environ.get("DF_MOBILE_"+key.upper()) or (open(os.path.join(CRED_DIR,key)).read().strip() if os.path.isfile(os.path.join(CRED_DIR,key)) else key)
    cur.execute("select uid from jiuwu_account where mobile=%s limit 1",(mobile,)); u=cur.fetchone(); uid=u[0] if u else None; print("uid:",uid)
    cur.execute("select o.order_number,o.goods_id,o.status,o.sale_type,g.root_category_id,o.created_at from jiuwu_sellers_order o left join jiuwu_goods g on g.id=o.goods_id where o.uid=%s order by o.id desc limit %s",(uid,int(sys.argv[3]) if len(sys.argv)>3 else 3))
    for r in cur.fetchall(): print("seller:",r)
