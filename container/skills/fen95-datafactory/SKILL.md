---
name: fen95-datafactory
description: 95分（T1 环境）造数一条龙：拿到用例要的页面/状态 → 查状态机知道怎么到 → 调造数工厂造出来（可选 profile=real 真实感商品）→ 读 T1 库核终态。触发词：造数、造单、造个商品、把订单推到 XX 状态、这个状态怎么造、配方。
---

# 95分 造数 skill

把"用例要什么状态"变成"T1 里一张真实可点的单"。四样东西，都在本目录，无软链：

| 目录 | 是什么 | 真值在哪 |
|---|---|---|
| `statemachine/` | 卖家单(寄售/挂售/拍卖)/回收单/买家单 三图合一的状态机 JSON + 查询脚本 `smq.py` | `fen95-flows/tools/statemachine/build_sm.py`，改图改它再 `sync.sh` |
| `datafactory/` | 工厂直调 `df.py`、T1 终态核验 `t1q.py`、两个脚本化配方 | `fen95-flows/tools/datafactory/` |
| `recipes/` | 87 条配方 `recipes.json` + 查询 `rq.py` + 导出脚本 | 飞书多维表格「配方表」tblrZVesFOvjpDpM（维护入口），`export_recipes.py` 导出 |
| `docs/` | 工厂「真实感造数 profile」改造说明（给测试同学的那份） | 个人资产/项目/95分业务知识内化/13 |

版本在 `VERSION`，变更在 `CHANGELOG.md`。**这套东西会频繁改**（大杰 10-13 原话"肯定会改的"），用之前先看 CHANGELOG 顶上一条。

## 在哪跑

- `smq.py` / `rq.py`：任何机器，纯本地 JSON。
- `df.py` / `t1q.py`：**只能在细狗 xigou（用户 admin）跑**，手机号从 `~/mock95/.df_creds/` 读，T1 库连接信息从 mothership 各服务 `conf.t1.yaml` 取。细狗上的副本在 `~/mock95/dfrun/`；要更新用 `scp` 覆盖（禁止 scp 业务代码到服务器，这两个是本地工具不在此列）。
- 工厂地址：supply `10.217.8.230:8084`、trade `:8096`，请求头 `autotest: yes`、`dataSourceType: t1`。

## 五步法（agent 照着走）

1. **把用例翻成目标状态**：图（seller/recycle/buyer）+ 状态码 + 品类 rid + 类型（寄售/挂售/拍卖）。拿不准先 `python3 statemachine/smq.py search <关键词>` 或 `nodes seller` 看 App 文案对照。
2. **问状态机怎么到**：`python3 statemachine/smq.py how <graph> <status> [rid] [type] --json`。输出路径、每步工厂场景、挂的配方 id、品类注意。证据等级是"推断"的边别当事实。
3. **查配方拿具体命令**：`python3 recipes/rq.py <配方id>`，或 `rq.py find <关键词>`。配方里有入口/场景码、前置配方、红线、验证方法。状态=「已验证」的才直接用；「待填」「已填未验」要先自己跑通再用。
4. **调工厂**（在细狗）：`python3 ~/mock95/dfrun/df.py supply /api/jiShou/e2e '{"mobile":"seller_mobile_main","rid":1,"scene":"OnSaleService","env":"t1"}' 300`。
   - 要商品看着像真的：加 `"profile":"real"`（随机线上池商品）或 `"profile":"real:<gid>"`（固定一件，复现用），响应 `poolGid` 回传、`poolNote` 记录瑕疵/鞋盒信息写入结果。先 `/api/pool/pick` 看一眼也行。范围：寄售链 8 个一级类目（数码除外）图/成色/价/瑕疵/附件信息都走池；挂售线、数码线、服务包线未接。细节见 `docs/datafactory-profile-real.md`。
   - 绝大多数工厂接口是"按手机号新建一张单跑到指定节点"，不是对已有单续推；吃单号的只有 `/api/jiShou/supply`、`payMock`、`getBack`、`guaShouAudit`。
5. **核终态，三层都要**：库 `python3 ~/mock95/dfrun/t1q.py seller <单号|goods_id>`（status / audit / 轨迹节点）；App 深链 `fen95://95fenapp.com/goods/goodsDetail?goodsId=<id>&rid=<rid>` 截图看用户可见面；需要的话再核 ES/缓存。"接口返回 200"不算造成。

## 三级策略（大杰 10-13 定）

接口优先 → 改表只改时间 / 价格 / 保质期这类不碰状态的字段 → 插数据改状态是最后手段。工厂自己也有改表的（寄售转回收鉴别环节），不丢人，但要在配方里写清楚是第几级。

## 红线

- T1 可以真实出价 / 发布 / 改价 / mock 支付；退登、删数据、实名、删除类按钮不碰。预发 / 线上一律不造。
- 主号是无理由账号，造"问询买家"用 z3（`seller_mobile_z3`）。
- 造完一定核库，核库一定带单号写进汇报。

## 迭代规则

- 改脚本/状态机：在 `fen95-flows/tools` 改 → 跑 `./sync.sh` → 改 `VERSION` → `CHANGELOG.md` 记一行。
- 改配方：在飞书表改 → `python3 recipes/export_recipes.py` → 记 CHANGELOG。
- 改工厂：走 datafactoryservice MR，合并后更新 `docs/` 和 `datafactory/README.md` 的边界段。
- 发现"状态机说能到但实际到不了"：先在配方表把那条改成「已填未验」+ 备注，再改 build_sm.py 的证据等级，别只改 JSON。

## 当前边界（0.2.0）

- 寄售链 profile=real 实测过的品类：鞋 1、服 2、包 25、表 26、配饰 70、美妆 71、潮玩 72（10-14 T1 各造一单核库）。数码 35 走 supplyC 未接。
- 非鞋类目的瑕疵文案是线上真实名称，但 id 是借 T1 测试树的节点（T1 这些类目没有真实瑕疵树），后台按 id 反查会对不上，App 展示没影响。
- 池价低于 T1 该 SPU 价格下限会被出价接口改成提示价（原有 8001 重试逻辑）。
- 挂售复审在工厂有 NPE、数码线 PHP 报错、问询态无入口，这三条挂账。
