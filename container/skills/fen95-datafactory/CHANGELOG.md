## 0.4.0 (2026-10-14)
- df.py / t1q.py 去掉写死的 /Users/admin 路径：`DF_CREDS_DIR`/`DF_MOBILE_*`/`DF_SUPPLY_BASE`/`DF_TRADE_BASE`/`MOTHERSHIP_DIR`/`T1_DB_DSN` 可配置，手机号别名缺失时原样透传。
- 接入 nine-refine `requirement-testing` 员工：employee.json skills 加 fen95-datafactory，CLAUDE.md 造数段改为允许在 T1 用本 skill 造数（账号用运行上下文下发的号）。
- SKILL.md「在哪跑」改写为员工视角。

# 变更记录

版本号三段：状态机/配方/工厂接口有不兼容变化升中段，补配方补边升末段。改任何一处都在这里记一行：日期 · 改了什么 · 为什么 · 谁拍板。

## 0.3.0 · 2026-10-14
- 池 v2：全部改从数仓 jiuwu_sc 导出（6000 件，含已售挂售瑕疵、3C 报告、鉴别照），v1 gid 作废。
- 池货号真正可用：控制器不预填默认货号 + Black getSpuList 可用性校验；不可用回退默认，poolNote 记录。
- 数码线 /api/jiShou/supplyC 接 profile（池货号/成色/图/3C 报告覆盖）；挂售线 /api/guaShou/e2e 接 profile（只借图/成色/瑕疵，不用池货号）；服务包线透传 profile（只图/价）。
- 挂售线 T1 本身报 AssertionError 90000（与改动无关），未验通；MR !324 待合。
- 配方 D-商品-寄售鞋真实感-01 / D-商品-寄售全品类真实感-01 备注更新。

## 0.2.0 · 2026-10-14
- 工厂分支 dagou/goods-pool-v1 补齐非鞋类目：二检前补写池瑕疵（借 id 写真实文案）与 define_word，响应新增 poolNote；T1 实测 服/包/表/配饰/美妆/潮玩 六类各一单。大杰 10-14 00:02 "那你补啊别磨叽"。
- 同步 datafactory/README 边界段、docs 说明。

## 0.1.0 · 2026-10-13
- 首版打包：状态机 JSON（63 节点 / 59 边）+ smq.py、造数直调 df.py + T1 核验 t1q.py、配方 87 条导出 recipes.json + rq.py、工厂真实感造数 profile 说明。
- 已知范围：寄售链路 + 鞋类完整；其它品类瑕疵未接池；挂售/数码/服务包建单未接池；问询态无造数入口（挂账）。
