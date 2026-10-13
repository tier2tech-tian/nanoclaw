# 造数工厂「真实感造数 profile」改造说明

> 仓库 jiuwuqa/datafactoryservice，分支 `dagou/goods-pool-v1`，MR !322（http://code.shihuo.cn/jiuwuqa/datafactoryservice/-/merge_requests/322）
> 2026-10-13 已按分支部署到 T1 造数工厂（supply 8084 / trade 8096），master 未合。

## 一、一句话

寄售链路造数请求多一个**可选**参数 `profile`：不传，一切和原来一样；传 `"real"`，造出来的商品会用一件线上真实商品的实拍图、瑕疵、鞋盒鞋龄和价格，App 里看起来不再是「4 张固定图 + 1 条随机瑕疵 + 随机价」。

## 二、为什么改

自动化测试拿造数工厂造的商品做截图、做评测，商品页看着太假：图片永远是同一组，瑕疵随机 1 条，价格随机三位数，鞋盒信息固定。模型和人都能一眼看出是测试数据。线上在售商品的真实数据是现成的，导一批进工厂当「造数池」，造的时候照着池子填，成本最低。

## 三、怎么用

### 3.1 造数请求（supply `/api/jiShou/e2e`，其它走 `jiShouSellerDelivery` 建单的寄售场景同理）

```json
{
  "mobile": "1xxxxxxxxxx",
  "rid": 1,
  "scene": "OnSaleService",
  "env": "t1",
  "profile": "real"
}
```

| profile 取值 | 行为 |
|---|---|
| 不传 / 空 | **与改造前完全一致**，一行逻辑都不走 |
| `real` | 按 rid 从池里随机取一件真实商品，用它的图 / 瑕疵 / define_word / 价格 |
| `real:<gid>` | 固定用池里这一件，用于复现；gid 从响应或 `/api/pool/pick` 拿 |
| 其它 | 直接 400 `profile 取值不合法`，不建单 |

响应 `content.poolGid` 回传本次用的池商品 gid。`extendIsNew` 仍然优先于池成色；`code` / `extendSkuId` 仍然优先于池货号。

### 3.2 看池子（只读，不碰库）

```
POST /api/pool/pick   body {"rid":1,"isNew":40,"saleType":3,"count":3}   或 {"gid":"146483842306281565"}
GET  /api/pool/stats
```

请求头和其它接口一样（`autotest: yes`、`dataSourceType: t1`）。

## 四、池子是什么

- 来源：线上 BI 只读库（`trade_jiuwu_bi`，`innodb_read_only=1`），2026-10-13 导出，只取**在售**商品，**不含任何用户字段**（没有 uid / 手机号 / 卖家信息）。
- 数量：3155 件，8 个一级类目各 ≤400（鞋 1 / 服 2 / 包 25 / 表 26 / 数码 35 / 配饰 70 / 美妆 71 / 潮玩 72）。
- 每件带：货号、尺码、标题、成色 is_new、销售类型、价格、同 SPU 价格区间、白底图、实拍图 ≤10 张、瑕疵 ≤8 条（对象/位置/项目/程度/图）、define_word 原文（鞋盒/鞋龄/自定义瑕疵组）。
- 存放：`common/src/main/resources/goods_pool.json`（3.9MB），打进 jar，服务首次用到时加载一次，之后只读。
- 更新：重新导出覆盖这个文件即可，`version` 字段写导出日期。

## 五、改了什么（13 个文件改动 + 5 个新文件）

| 模块 | 文件 | 改动 | 生效条件 |
|---|---|---|---|
| common | `common/pool/GoodsPool.java` `PoolItem.java` `PoolFlaw.java` `PoolProfile.java`（新） | 池加载 / 抽样 / profile 解析 | — |
| common | `resources/goods_pool.json`（新） | 池数据 | — |
| supply | `SceneRequest.java` | 加 `profile` 字段 | — |
| supply | `SupplyCommonData.java` | 加 `poolItem` 字段 | — |
| supply | `SceneManager.java` | `jiShouSellerDelivery` / `jiShouGoodsCollectionDelivery` 选池商品；`resolveJiShouCode` 货号为空且池货号在 T1 存在时用池货号；`execWarehousingE2E` 透传 poolItem；`jiShouPriceGoods` 透传池价 | profile=real |
| supply | `ProductManager.java` | `updateGoodsAttr` 末尾用池图整体替换；`addFlawInfo` 先按池瑕疵映射，映射不上回退原随机；define_word 用池原文并跳过固定鞋盒鞋龄 | 池商品有图 / 有瑕疵 / 有 define_word |
| supply | `StorageRepository.java` `SupplyChainFunction.java` | 新增 `existsSpuCode(code)`（查 `jiuwu_commodity_spu`） | — |
| supply | `TradeBuyerRequest.java` `StorageManager.java` | 加 `price` 字段和带 price 的 build 重载 | — |
| supply | `SupplyResp.java` `SceneService.java` | 响应加 `poolGid` | — |
| supply | `controller/production/PoolController.java`（新） | `/api/pool/pick` `/api/pool/stats` | — |
| trade | `GoodsReq.java` | 加可选 `price` | — |
| trade | `GoodsController.java` `Consign.java` | `pricingGoodsWithPrice`：price 非空按该价出价，空则原随机价；8001 超限重试逻辑不变 | price 非空 |

**不传 profile 时**：`poolItem` 为 null，上面所有分支都是 `if (poolItem != null)` 包着的，走原代码；trade 侧 `price` 为空走原随机价。原有调用方不需要改。

### 瑕疵映射规则（最容易有疑问的一处）

线上池里瑕疵只有名称，T1 的瑕疵配置 id 和线上不同，而且树的命名也不一样（线上常写「鞋主体 > 鞋底 > 磨损」，T1 一审树只有「左右鞋 / 左鞋 / 右鞋 / 配件 / 鞋盒 / 鞋底」）。所以写入前按名称在当前环境 `GetFlawConfig` 返回的 modular 里反查：

1. 对象名精确命中且位置名命中 → 用它
2. 否则按位置名在全部对象里找（左右鞋 > 鞋主体 > 整体 > 包身 > 衣身 优先）
3. 项名：精确 → 同义词（脏污=污渍、长期使用痕迹=磨损、穿着磨损=磨损、氧化泛黄=氧化/泛黄、污渍/染色=污渍、划痕/磨损=划痕）→ 包含 → 该位置第一项
4. 程度：精确 → 第一个
5. 整条对不上就跳过；一条都没映射上回退原随机逻辑

## 六、T1 验证结果（2026-10-13 21:15）

同一池商品（gid 146483842306281565，adidas neo Breaknet，60 新，¥89）跑 `firstAuditE2EService` 和 `OnSaleService`，和不传 profile 的对照单比：

| 项 | profile=real | 不传 profile |
|---|---|---|
| `jiuwu_goods.is_new` | 60（池成色） | 20 |
| `jiuwu_goods.img_attr` | 9 张线上实拍 | 4 张固定默认图 |
| `jiuwu_flaw_setting` | 左右鞋 > 鞋底 > 磨损 > 极轻微（由池 鞋主体>鞋底>磨损 映射） | 鞋底 > 鞋垫 > 破损（随机） |
| `jiuwu_flaw_setting_attr.define_word` | 池原文「无鞋盒」 | 固定「鞋盒 original」 |
| `jiuwu_goods.price` / `jiuwu_sellers_order.price` | 89 / 89 | 随机三位数+9 |
| App 商详 | 实拍 1/10 带「左鞋内侧」标注，A级 轻微使用，券后价 59 | — |

复现性：`profile=real:146483842306281565` 两次结果一致。

## 七、已知边界（下一版）

1. 池货号 T1 不一定有 SPU（这次 FX8725 就没有）：货号回退原解析（随机池 / 默认货号），标题和白底图是 T1 那个 SPU 的，实拍图是池里的，两者不是同一双。要对上得在 T1 建 SPU，或者导池时只取 T1 也有的货号。
2. 瑕疵只在走 `addFlawInfo` 的分支生效（鞋 rid 1 一审、挂售一检）；服饰 / 包 / 表等走 `flawInfoManager.requiredFlawInfo`，这次没接池。
3. 挂售品池里本就没有瑕疵（线上挂售在售品瑕疵为空），3C 鉴别报告也没进池。
4. 池图是 6048px 原图，模拟器网络差时加载慢（验证当天细狗到 CDN 只有 25KB/s，图全空白但 URL 都 200）。下一版导出时可改用 OSS 缩放后的 URL。
5. `jiShouGoodsCollectionDelivery`（同运单批量建单）两单共用同一件池商品。

## 八、建议的合并方式

- 不传 profile 零影响，可以直接合 master；担心的话先在 T1 跑几天（现在 T1 跑的就是这个分支）。
- 想回退：Jenkins 两个 job 用 `branch=origin/master` 重新构建即可，池是只读文件，不留库里痕迹。
- 本机编译：JDK 8 + `mvn -pl common,supply,trade -am -DskipTests compile`。

## 九、案例（可视化）

**效果对比页（浏览器直接看真图）**：http://10.117.0.159:8090/dfpool-effect-20261013.html （内网）。页面数据全部从 T1 库取，图片是库里存的 URL 直出；左列是不传 profile 的对照单，右列绿框是 profile=real 造出的。

| | 改造前（不传 profile） | 案例 1 real:146483842306281565 | 案例 2 real（随机抽到 146572084338757641） |
|---|---|---|---|
| T1 goods_id | 147352347020886150 | 147353436583624838 | 147356050272551046 |
| 线上来源 | — | adidas neo Breaknet FX8725，线上 60 新 ¥89 | adidas neo Hoops 2.0 FW5995，线上 80 新 ¥69 |
| 展示图 | 4 张固定默认图（一双灰色雪地靴，和 SPU 对不上） | 9 张线上实拍（白色板鞋含鞋底） | 9 张线上实拍（绿黑中帮含鞋底） |
| 成色 | 20 | 60 | 80 |
| 瑕疵 | 鞋底 › 鞋垫 › 破损（随机） | 左右鞋 › 鞋底 › 磨损（池 鞋主体›鞋底›磨损 映射） | 左右鞋 › 鞋底 › 磨损（池 鞋主体›鞋底›长期使用痕迹 走同义词映射） |
| 鞋盒 / 鞋龄 | 固定「鞋盒 original」2 图 | 无鞋盒 · 鞋龄 6 个月内（池原文） | 非原装鞋盒 · 鞋龄 6 个月内（池原文） |
| 出价 | 随机三位数+9 | ¥89 = 池价 | ¥6489：池价 69 低于 T1 该 SPU 价格下限，被出价接口 8001 拦截后按提示价重出（原有逻辑，池价只是「尽量」） |
| T1 货号 / 标题 | 332550-601 | 653532-100 Air Jordan 1 SB（⚠ 池货号 T1 没有，标题和实拍不是同一双，见边界 1） | 555112-500 Air Jordan 1 Pro（同上） |

案例 2 顺带暴露一条新边界：**池价低于 T1 价格下限时会被改成接口提示价**，和改造前 8001 重试行为一致，不是 bug，但想要价格也真实得先让 T1 的 SPU 价格区间和线上对齐。

下面两张图：对比页整页截图、App 商详（sim2，鉴别报告段，A 级轻微使用；图片空白是当时细狗网络 25KB/s 拉不动原图）。

## 十、10-14 00:25 非鞋类目补齐（大杰 00:02 "那你补啊别磨叽"）

分支新增两个提交（b50d946 → f488377，Jenkins supply #190~#192），T1 已部署。

**改了什么**：非鞋类目原流程在寄售链里不写任何瑕疵，而且它们的二检是自动通过的（`doSecondCheck` 开头 `auditCheck` 直接 return），所以在二检方法最前面加 `addPoolFlawInfoNonShoe`：profile=real 且池商品带瑕疵/附件信息时，写 saveFlawSetting + updateFlawSetting(define_word)。任何失败只记日志不打断造数。响应新增 `poolNote`（例：`池瑕疵 写7(借id7) 跳0；池define_word 已写`），没有服务器日志权限时靠它排查。

**为什么要"借 id"**：T1 非鞋类目的瑕疵配置树是测试配置（配饰只有 耳环/耳坠/耳钉，潮玩叫"潮玩瑕疵对象 > 潮玩瑕疵部位"），线上池里的 项链类 › 吊坠 › 磨损 永远对不上名。`jiuwu_flaw_setting` 存的是文案，App 展示的也是文案，所以借第一个有效节点的 id，文案写线上真实名称。后台按 id 反查会对不上，测试环境可接受；鞋类仍走真实树映射。

**T1 实测（六类各一单，OnSaleService，profile=real）**：

| 类目 | goods_id | 成色 | 图 | 瑕疵（poolNote） | define_word | 价 |
|---|---|---|---|---|---|---|
| 服 2 | 147373141558034566 | 60 | 6 | 池无瑕疵 | 已写（细节实拍组 + 图） | 804 |
| 包 25 | 147373306444513414 | 40 | — | 写 2（借 id） | 包沿用原规则不写 | — |
| 表 26 | 147373373905698950 | 80 | 6 | 写 7（借 id） | 池无 | 160 |
| 配饰 70 | 147372975513927814 | 80 | 3 | 写 7（借 id）：项链类›刻印›刻印细节、吊坠›破损开裂/磨损/氧化/生锈、链条›磨损/氧化 | 已写（实物全套附件如图 + 图） | 2099 |
| 美妆 71 | 147373443061383302 | 20 | — | 池无瑕疵（poolNote 空） | 池无 | — |
| 潮玩 72 | 147373047421075590 | 40 | 4 | 写 2（借 id） | 池无 | 999 |

对比页加了案例 3（配饰，对照单 147373340451930246 原流程零瑕疵）：http://10.117.0.159:8090/dfpool-effect-20261013.html

**本轮踩的坑**：① 部署后 10 秒内的第一单建单失败（"卖家订单号没有获取到"），重跑正常，是冷启动，验证前等 30 秒；② 我第一版把补写放在二检方法后半段，非鞋类目根本跑不到，靠 poolNote 才发现。

**仍未接**：数码 35（走 supplyC 不经过 e2e）、挂售线、服务包线。

## 十一、10-14 01:30 一把梭进展（大杰 00:35 "指定计划一把梭"）

**合并状态**：!322 同事已合 master，但只含前 3 个提交（到 4ee6e51）。之后的改动都在分支 `dagou/goods-pool-v2`，新开 MR !324，T1 当前跑的就是这个分支。

**本轮做了什么**

| 项 | 结果 | 证据 |
|---|---|---|
| 池货号真正用上 | 修了两层：① `SceneController` 在 profile=real 且没传 code 时不再预填默认货号；② 用池货号前先过 Black `getSpuList` 可用性校验（T1 有 SPU 但"不在平台接受范围内"的会被拦，比如 FX8725），不可用回退默认并写进 poolNote | 随机两单直接用上池货号 332148-137 / M44480，标题白底图和实拍同一件 |
| 池 v2（数仓） | 全走 MaxCompute jiuwu_sc，不碰线上库：`dm_goods_ds` + `dwd_goods_baseinfo_ds`（dt=20261012）+ `dwd_spc_flaw_setting_df` + `dwd_spc_flaw_setting_attr_ds` + `dwd_spc_examining_report_df` + `dwd_goods_backup_img_df`；10 类目 × 寄售/挂售 × 在售/已售 各 ≤150 = 6000 件，10.6MB，含 2935 件带瑕疵（其中已售挂售品 769 件）、301 份 3C 报告、893 件鉴别照 | `/api/pool/stats` version 2026-10-14-v2；**v1 的 gid 全部失效** |
| 数码线接池 | `/api/jiShou/supplyC` 支持 profile；池货号/成色/实拍图；3C 鉴别报告按"模版定字段、线上定内容"覆盖（basic/appearance 标量，空值不覆盖，img_arr 用池图，character 保持模版） | goods 147378507700240518：报告 other_remark=线上序列号 TJ150259FA1433、img_arr 1 张池图；对照单是随机串 |
| 挂售线接池 | `/api/guaShou/e2e` 支持 profile；**挂售一律不用池货号**（交易侧有独立可售白名单），只借图/成色/瑕疵 | **未验通**：T1 挂售线本身坏了——不带 profile 同货号同场景也报 `AssertionError expected [0] but found [90000]`，包类同样；和改动无关，挂账 |
| 服务包线 | 寄售/挂售服务包请求透传 profile，只走图/价，瑕疵仍按质检模版 | 未单独验（服务包需要模版配置） |
| 非鞋类目瑕疵 | 见 §十 | 六类各一单 |

**本轮踩的坑**：① zsh 里 `GID` 是保留变量，脚本里用它当变量名会报"failed to change group ID"；② 数码报告模版校验 appearance.remark 必填，线上空值不能覆盖；③ 挂售默认货号池里有不能售的货号，建单直接报"暂时不支持出售该商品"，和 profile 无关。

**没做的（下一轮）**：同运单批量建单两单共用一件池商品；回收单、拍卖线未碰池；挂售线等 T1 修好再验；配方 #13、三条真缺边、未抽状态（状态机侧）；非鞋类目 T1 没有真实瑕疵树，瑕疵 id 是借的。
