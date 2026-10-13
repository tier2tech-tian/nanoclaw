# 造数工厂直调 + T1 终态核验（跑在细狗 xigou，用户 admin）

- `df.py <supply|trade> <path> '<json>' [timeout]` — 直调 datafactoryservice（supply 8084 / trade 8096）。body 里写 `"seller_mobile_main"` / `"seller_mobile_z3"` 会从 `~/mock95/.df_creds/` 读真实手机号，输出自动打码。
- `t1q.py seller <order_number|goods_id>` / `recycle <sn|sell_order_number>` / `buyer <order_number>` / `latest <creds_key> [n]` — 读 T1 库核终态，连接信息从 mothership 各服务 `conf.t1.yaml` 取（3307 密码要 str()）。
- 配方实测记录：个人资产/项目/95分业务知识内化/08-配方实测A结果-20261013.md；配方表 tblrZVesFOvjpDpM。

## 真实感造数 profile（工厂分支 dagou/goods-pool-v1，MR !322，2026-10-13）

工厂寄售链路请求体多一个可选字段 `profile`：
- 不传 → 和以前一模一样（默认图 4 张、随机 1 条瑕疵、随机价）
- `"profile":"real"` → 按 rid 从线上导出的造数池随机取一件真实商品：实拍图整体替换、瑕疵按名称反查 T1 配置写入、鞋盒鞋龄用线上 define_word 原文、出价用线上价；货号在 T1 存在时顺带用它的货号（标题/白底图就和实拍图是同一双）
- `"profile":"real:<gid>"` → 固定用池里这一件，复现用；响应 `content.poolGid` 就是本次用的 gid

先看池子再造：
```
python3 df.py supply /api/pool/pick '{"rid":1,"isNew":40,"saleType":3,"count":3}'
curl -s --noproxy '*' -H 'autotest: yes' -H 'dataSourceType: t1' http://10.217.8.230:8084/api/pool/stats
python3 df.py supply /api/jiShou/e2e '{"mobile":"seller_mobile_main","rid":1,"scene":"firstAuditE2EService","env":"t1","profile":"real"}' 300
```
边界：池瑕疵只在走 `addFlawInfo` 的分支生效（鞋 rid 1 一审、挂售一检），其他类目的瑕疵仍是原逻辑；池货号 T1 没有时只借图/瑕疵/价，货号走原解析。
