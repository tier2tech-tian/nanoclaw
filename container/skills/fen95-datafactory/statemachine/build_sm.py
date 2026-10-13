#!/usr/bin/env python3
"""把 05/06/07/08 四份文档里的三张状态机合成一份 agent 可查的 JSON。
改图改这里再跑 `python3 build_sm.py` 重新生成 fen95_state_machine.json。
证据等级：源码 = 读到实现；数据 = T1 日志/历史表统计出现过；推断 = 未见实现。
"""
import json, pathlib

SRC = "细狗 ~/code/mothership/server"
E = "order/ms-goods-order/internal/domain/entity/sellers_order.go"
C = "order/ms-goods-order/internal/domain/aggregate/cmd/"

def edge(id, graph, frm, to, action, who, impl, evidence="源码", precondition="", entry="", app_view="",
         sale_types=None, category_params=None, recipes=None, factory=None, notes="", coupling=None, kind=None):
    if kind is None: kind = "bypass" if id.startswith("X") else "normal"
    return {"id": id, "graph": graph, "kind": kind, "from": frm, "to": to, "action": action, "who": who,
            "precondition": precondition, "impl": impl, "entry": entry, "app_view": app_view,
            "evidence": evidence, "sale_types": sale_types or [], "category_params": category_params or [],
            "recipes": recipes or [], "factory": factory or [], "coupling": coupling, "notes": notes}

# ---------------- 卖家单 ----------------
seller_nodes = {
 "0": {"name": "出售中", "enum": "Selling/Todo", "app_sub": ["2001 出售中", "2002 接受还价待买家付款", "2003 买家已付款(寄售)", "1001 挂售审核中(挂售+audit 0)"]},
 "1": {"name": "待发货", "enum": "PendingShipping/ToDelivery", "app_sub": ["3002 待发货", "3001 待取件(有取件时间+运单号)"], "notes": "寄售刚创建=卖家待寄出；挂售买家付款后=卖家待发货"},
 "2": {"name": "已发货", "enum": "Shipped/DeliverySuccess", "app_sub": ["4001 待平台收货"]},
 "3": {"name": "交易完成", "enum": "Complete/Success", "app_sub": ["5001 交易完成"]},
 "4": {"name": "交易关闭", "enum": "Cancel/Close", "app_sub": ["6001 交易关闭", "6002 审核不通过(挂售 audit 2)"]},
 "5": {"name": "平台查验中", "enum": "Checking/InspectionGoing", "app_sub": ["4002 平台已收货(仓内节点=已入库)", "4003 平台查验中(仓内节点=平台查验)"], "notes": "已入库后仓内分拣/鉴定/一检/二检/复审全在这一个主状态里，真值在唯一码状态+质检单状态"},
 "6": {"name": "平台查验不通过", "enum": "CheckingFail/InspectionFail", "app_sub": ["6004 退回中(未签收且未满7天)", "6005 已退回(签收或满7天)"]},
 "7": {"name": "待支付", "enum": "Gen/ToPay", "app_sub": ["1002 待支付保证金(挂售)"], "notes": "改价/保证金场景"},
 "8": {"name": "待上架", "enum": "PendingShelve/ToShelves", "app_sub": ["1004 寄售待上架", "6050 美妆待取回(品类71且保质期剩余<售卖期)"]},
 "9": {"name": "取回中", "enum": "Retrieving/ToRetrieveGoing", "app_sub": ["6006 申请取回(无退回运单号)", "6004 退回中(有退回运单号)"]},
 "10": {"name": "已取回", "enum": "Retrieved/ToRetrieveSuccess", "app_sub": ["6005 已退回"]},
}
seller_meta = {
 "table": "trade_jiuwu.jiuwu_sellers_order.status",
 "enum_defs": ["order/ms-sale/internal/constant/enum/user_order.go:39-49", "order/ms-goods-order/internal/constant/enum/seller_order.go:173-185", "infrastructure/ms-atom/biz/bizstatus/status.go:8-18"],
 "sub_status_defs": "order/ms-goods-order/internal/constant/enum/seller_order.go:119-145；推导 job/service/ordersync/consignbuilder.go(寄售) / normalbuilder.go(挂售)",
 "sale_type": {"0": "挂售", "1": "拍卖", "3": "寄售"},
 "order_type": {"1": "寄售", "2": "转寄存", "3": "C2C"},
 "audit_layer(挂售)": {"table": "jiuwu_goods.audit_status", "values": {"0": "待审核→1001 挂售审核中", "1": "通过→2001 出售中", "2": "失败→6002 审核不通过", "3": "退回修改→1003 待修改"}, "who": "AI 审核 order/ms-aiaudit；仓库质检回写 AuditForBlack；PHP 后台 goods executeAutoAudit/executePublish", "impl": "ms-goods-order/job/service/ordersync/normalbuilder.go:29-71"},
 "t1_distribution": "寄售 100 万；挂售 37 万(4:22万 0:6.5万 7:4.3万 5:2.5万 3:1.3万)；拍卖 826",
}
seller_edges = [
 edge("E1","seller",None,"1","用户提交寄售(创建寄售单)","App", f"{E}:780 CreatedConsignSellerOrder SetStatus(1)", entry="ms-sale basicservice/add_mapping_order.go→CreateConsign；PHP JiuwuSellersOrderForm:6011 addPersonalConsignOrder；路由 /api_new_sale/addConsign/v1.0、/api_seller/doConsign", app_view="3002 待发货；预约取件后 3001 待取件", sale_types=["寄售"], recipes=["D-寄售单-待发货-01"], factory=["trade /api/trade/jishou scene=JiShouAppSave*（按 mobile 新建）","tools/datafactory/recipes/consign_create.py"]),
 edge("E2","seller","1","2","快递揽收 / 用户自寄填单号","物流回调 或 用户", f"{E}:602 Deliver", precondition=f"{E}:248 CanDeliver 要求状态 1", entry="fulfillment/ms-logistic-tracing saveExpressInfo.go:136；揽收通知 des_collection_notify.go:307 直接 DAO 1→2；PHP 顺丰回调", app_view="4001 待平台收货", sale_types=["寄售","挂售"], recipes=["D-寄售品-数码在售-01","D-寄售品-箱包在售-01"], factory=["supply JiShouAppSaveExpressController","GuaShouSellerExpressNewController(挂售)"]),
 edge("E3","seller","2","5","仓库扫码入库","仓库", f"{E}:648 InBound", precondition=f"{E}:256 CanInbound 要求状态 2", entry="fulfillment/ms-black atom_service/order/order.go:322 SellersWarehousing ← exec_warehousing.go:245 / batch_warehouse.go:471；PHP storage_operation executeInCheckUp", app_view="4002 平台已收货", sale_types=["寄售","挂售"], recipes=["D-寄售单-待上架-01","D-挂售单-仓内节点-01"], factory=["supply /api/jiShou/e2e execWarehousingServiceE2E","按单 execWarehousingService","挂售 execGuaWarehousingServiceE2E"]),
 edge("E3x","seller","5","5","仓内推进：分拣/鉴定/一检/二检/一审/二审(主状态不变，子状态 4002→4003)","仓库", "真值在唯一码状态(uniqueenum 90 个)和质检单状态(ms-black-inspection ccc_rule.go)", evidence="推断", app_view="4003 平台查验中", sale_types=["寄售","挂售"], recipes=["D-寄售单-待上架-01","D-挂售单-仓内节点-01"], factory=["supply /api/jiShou/e2e 线上别名：寄售入库/分拣/一检/二检(无复审)","supply_guashou_e2e：挂售待入库/入库/分拣/一检"], category_params=["仓库质检自动通过"]),
 edge("E4","seller","5","8","质检通过上架","仓库", f"{E}:592 ShelvesForSale", precondition=f"{C}shelves_for_sale_cmd.go check()：寄售、成色已定、状态 5、质检 AuditPassed、有概况图(数量按品类 shelves.go:138 GetMinPicNumber)", entry="ms-black ccc_bs/shelves.go:194 ShelvesHandle→:312 shelvesForSale；App 侧 ms-sale sell_price.go:189 InspectionPassedShelve；PHP GoodsShelves.php:283", app_view="1004 寄售待上架；美妆临期 6050", sale_types=["寄售"], category_params=["3C 独立流程","家电","上架门槛","美妆临期"], recipes=["D-寄售品-数码待上架-01"], factory=["supply /api/jiShou/e2e firstAuditE2EService(一检二检复审一步到 8；鞋/箱包/服饰/珠宝验过)","数码走 supply /api/jiShou/supplyC bindingPositionService(实测 8)"], notes="寄售主线 e2e 对 rid 35 报\"3C 请使用老版本\"，数码必须走 supplyC"),
 edge("E5","seller","8","0","用户出价","App", f"{E}:703 Pricing(price, Selling)", precondition=f"{E}:332 CanPricing 寄售且状态 8；回收单不能出价", entry="ms-sale price/pricing/pricing_manager.go:49；自动定价 ms-goods-biz auto_price_service.go；路由 /api_goods/offerPriceConsign/v2.0、/sell_price/app_pricing", app_view="2001 出售中", sale_types=["寄售"], recipes=["D-寄售单-出售中-01"], factory=["supply OnSaleService"], notes="珠宝 OnSale 后 DB 成功但 App 列表不可见(D-寄售品-珠宝在售-01)"),
 edge("E6","seller","0","8","取消出价 / 价格过高自动下架","App 或 定时任务", f"{E}:770 CancelPricing", precondition=f"{E}:509 CanCancelPricing 要求状态 0", entry="ms-sale cron_off_shelve_too_high_goods.go；ms-goods-biz cron_cancel_pricing.go", app_view="1004 寄售待上架", sale_types=["寄售"], factory=[], notes="工厂无场景，App 脚本可做(07 #9)"),
 edge("E7","seller","0","0","买家下单付款(寄售主状态不变，只写 trade_number)","买家 App", f"{E}:750 BuyerPaid 注释\"挂售改待发货，寄售不处理\"", entry="finance/ms-pay、order/ms-trade", app_view="2003 买家已付款(goods.status 已售出 + 买家单 status∈{2,4,5})", sale_types=["寄售"], recipes=["D-寄售单-已售出-01"], factory=["trade payMock buyerPayMockController","supply jiShouAddAndExpressAndPricingAndBuy"], coupling="买家付款"),
 edge("E8","seller","0|2|5","3","成交完成：买家确认收货 / 平台出仓发货","买家 App 或 仓库", f"{C}seller_order_complete_cmd.go：商品已售出 + 状态∈{{0,2,5}}→3；另 {E}:728 DeliverOutOfWarehouse(前置 {E}:375 寄售要求 0 且质检通过，未见外部调用方)", entry="ms-trade order.go confirmSingleOrderReceipt→SellerOrderComplete；PHP executeStorageOut:1158、PlatformSendHandler:51", app_view="5001 交易完成", sale_types=["寄售","挂售"], recipes=["D-购买订单-交易完成-01"], factory=["supply waitCheckOutService→deliveryFinishService→checkOutServiceE2E","挂售 guaCheckOutService"], coupling="买家确认收货"),
 edge("E9","seller","5","6","质检不通过，退回卖家","仓库", f"{E}:733 ReturnsOutOfWarehouse", precondition=f"{E}:411 要求状态 5", entry="ms-goods-order out_of_stock_consumer.go:480(MQ)；PHP executeStorageOut:1212、handleSellerCheckFailed:2510", app_view="6004 退回中 → 签收或满 7 天 → 6005 已退回", sale_types=["寄售","挂售"], recipes=["D-寄售单-查验不通过-01"], factory=["supply /api/jiShou/e2e abnormallyOutService(10-13 实测 18 秒到 6)","firstCheckAbnormallyService","checkFailReturnToSellerService","3C threeSaveFailedReport→ToReturnDelivery/ToOutWarehouse"], notes="Go 生命周期日志里无 5→6，走 PHP/MQ"),
 edge("E10","seller","0|5|8","9","申请取回(付取回费)","App", f"{E}:667 Retrieve", precondition=f"{E}:281 CanRetrieve：出售中/查验中/待上架可取回，貔貅加已发货，回收单允许已取消；前置仓订单直接→10", entry="ms-goods-biz retrieve/retrieve.go:172；批量取回支付回调 consumer_batch_retrieve_pay_notify.go:344；PHP api_seller/retrieve；强制取回 ForceRetrieveService.php:189；长库龄 LongStockService.php:287(定时)", app_view="6006 申请取回；有退回运单号后 6004 退回中", sale_types=["寄售","挂售"], recipes=["D-寄售单-取回中-02","D-寄售单-取回中-01"], factory=["trade /api/tools/payMock retrievePayController(goodsid，对已有单，10-13 实测 3 秒 5→9，商品下架)","supply /api/jiShou/getBack pinkPickService/takeBackDeliveryService(只做仓库下架，不改状态)"]),
 edge("E11","seller","9","10","取回完成：签收 / 到期自动","定时任务 或 用户确认", f"{E}:662 FinishRetrieval", precondition=f"{E}:269 CanFinishRetrieval 要求 9，非回收单还要 updated_at+7 天({E}:22,326)", entry="ms-goods-biz cron_finish_retrieval.go(定时)；PHP api_recycle/confirmBack:51、api_seller/retrieveForBiz:78", app_view="6005 已退回", sale_types=["寄售","挂售"], recipes=["D-寄售单-已取回-01"], factory=["无(takeBackOutService 被注释；dataOps 只改结算时间)"], notes="二级配方：改 updated_at −8 天后等 cron 或调 FinishRetrieval(待填)"),
 edge("E12","seller","{非3,4,6,9,10}","4","关单：平台/商家/风控/用户取消","后台、定时、App", f"{E}:765 CloseOrder", precondition=f"{E}:453 CanCloseOrder 排除 3/4/6/9/10；关单场景由 {C}validator_factory.go 按 CloseType 分校验器", entry="ms-black order.go:769 CloseSellersOrder、outbound.go:1427 ShipTransfer；ms-tob/ms-recycle/ms-merchant；PHP api_user/canceListingOrder:75", app_view="6001 交易关闭", sale_types=["寄售","挂售","拍卖"], factory=["拍卖线 AuctionPayClose/NoPayClose/NoPayTimeoutClose","其他无场景(07 #14 真缺)"]),
 edge("E13a","seller","1","0","买家付款后取消，卖家单打回出售中(挂售)","买家 App", f"{E}:1409 BuyerCancelOrder", precondition="挂售已被买家付款(状态 1)", sale_types=["挂售"], recipes=["D-购买订单-售后中-01"], factory=["trade /api/trade/refundNew 8 场景"], coupling="买家取消/售后", kind="rollback"),
 edge("E13b","seller","0","8","售后取消后商品回到待上架(寄售)","买家 App / 后台", "ms-order seller_order_service.go:721 SellerOrderWaitUp，被 after_sale_cancel/after_pay.go:124,143、pay_back_sold.go:79 调；另 :1479 SellerOrderWaitRefund 打回 0", precondition="寄售商品已售出(卖家单仍 0)且买家售后取消", sale_types=["寄售"], recipes=["D-购买订单-售后中-01"], factory=["trade /api/trade/refundNew 8 场景"], coupling="买家取消/售后", kind="rollback"),
 edge("E13c","seller","0","5","平台发货前买家取消，退回查验中(寄售)","买家 App / 后台", f"{C}consign_verification_fail_close_cmd.go:60 SetStatus(5)，被 ms-order after_sale_cancel/consign_before_platform_send.go:120 调", precondition="寄售已售出且平台尚未发货", sale_types=["寄售"], recipes=["D-购买订单-售后中-01"], factory=["trade /api/trade/refundNew 8 场景"], coupling="买家取消/售后", kind="rollback"),
 # 挂售
 edge("H1","seller",None,"7|0","发布挂售","App", "PHP JiuwuSellersOrderForm:6096-6110 addPersonalOrderOrder：C2C 和潮玩盲盒直接 0，其余 7；Go C2C E:1085 CreateHangSellerOrder SetStatus(1)(含义待核)", app_view="1001 挂售审核中(audit 0) / 1002 待支付保证金", sale_types=["挂售"], recipes=["D-挂售单-审核中-01","D-商品-待审核自建-01"], factory=["trade /api/trade/guashou OrderReviewingController(审核中，先 /randomCode 取货号)"]),
 edge("H2","seller","7","0","支付保证金","App(T1 可 mock 支付)", f"{E}:738 PayDeposit", precondition=f"{E}:429 CanPayDeposit 要求 7 且挂售", evidence="源码+数据(T1 DoPayDeposit 12499)", app_view="2001 出售中(审核通过后)", sale_types=["挂售"], factory=["trade payMock sellerPayMockController"]),
 edge("HA","seller","0","0","商品审核通过(goods.audit_status 0→1，主状态不变)","AI 审核 / 后台 / 仓库质检回写", "ms-goods-order ordersync/normalbuilder.go:29-71 推子状态；写入 ms-aiaudit、AuditForBlack、PHP goods executePublish", app_view="1001 挂售审核中 → 2001 出售中", sale_types=["挂售"], recipes=["D-挂售单-审核通过出售中-01","D-挂售单-出售中-01"], factory=["trade /api/trade/guashou GuaShouOnSaleIngController(一步到 0/audit 1，10-13 实测)","supply /api/tools/guaShouAudit 只建 jiuwu_audit_task 不改 audit_status","newSaleAuditPass 是新发售审核，不适用"]),
 edge("H3","seller","0","1","买家付款(挂售改待发货)","买家 App", f"{E}:750 BuyerPaid", evidence="源码+数据(T1 DoBuyerPaid 10776)", app_view="挂售待发货", sale_types=["挂售"], recipes=["D-挂售单-待发货-01"], factory=["trade payMock buyerPayMockController"], coupling="买家付款"),
 edge("H4","seller","1","2","卖家发货/揽收(挂售)","卖家 App / 物流", f"同 E2 {E}:602 Deliver", evidence="源码+数据(DoDeliver 9874)", sale_types=["挂售"], factory=["trade GuaShouSellerExpressNewController","supply waitExecGuaWarehousingServiceE2E"]),
 edge("H5","seller","2","5","仓库入库(挂售)","仓库", f"同 E3 {E}:648 InBound", evidence="源码+数据(DoWarehousing 45988)", sale_types=["挂售"], recipes=["D-挂售单-仓内节点-01"], factory=["supply execGuaWarehousingServiceE2E"]),
 edge("H6","seller","5","3","质检通过出仓发给买家(挂售)","仓库", f"{E}:728 DeliverOutOfWarehouse 前置 {E}:396 要求 5+质检通过；实际走 seller_order_complete_cmd 0/2/5→3", evidence="源码+数据(OrderComplete 2→3 37)", sale_types=["挂售"], factory=["supply guaDeliveryFinish→guaCheckOutService"], coupling="买家确认收货"),
 edge("H7","seller","5","6","查验不通过退回(挂售)","仓库", "同 E9", sale_types=["挂售"], factory=["同 E9 abnormallyOutService 一族"]),
 edge("H8","seller","1","0","买家取消(挂售)","买家 App", f"{E}:1409 BuyerCancelOrder；售后取消打回 0/8/5 ms-order seller_order_service.go:721,1479,891", sale_types=["挂售"], factory=["trade /api/trade/refundNew"], coupling="买家取消/售后", kind="rollback"),
 edge("H9","seller","{0,1,2,5,7,8}","4","下架 / 关单 / 保证金超时(挂售)","App / 定时 / 后台", f"{E}:478 CanSoldOutOrder、{E}:453 CanCloseOrder", evidence="源码+数据(DoCloseOrder 7→4 61666 保证金未付超时)", sale_types=["挂售","拍卖"], factory=["拍卖 AuctionPayClose/NoPayClose/NoPayTimeoutClose"]),
 edge("H10","seller","拍卖","8","流拍 / 取消拍卖 → 转寄售待上架","定时 / App", f"{E}:1368 AuctionCancel SetSaleType(寄售)+8；{E}:703 Pricing 注释\"拍卖流拍重新寄售出价\"", sale_types=["拍卖"], recipes=["D-拍品-流拍已结束-01","D-拍品-进行中-01"], coupling="挂售⇄寄售"),
 # 旁路创建
 edge("X1","seller",None,"8|2","回收转寄售(创建成中间状态)","系统", "ms-goods-order transferconsign/transferrer/transfer_recycle_to_consign.go:145,182", sale_types=["寄售"], coupling="回收⇄寄售"),
 edge("X2","seller",None,"8|5","回收拒绝转寄售：服饰/童装/箱包/手表/配饰→8，其他→5","系统", "transfer_recycle_reject_to_consign.go:58-63", sale_types=["寄售"], category_params=["回收拒绝转寄售的目标状态"], coupling="回收⇄寄售"),
 edge("X3","seller",None,"2","退货转寄售","系统", "transfer_refund_to_self.go:67；履约侧 refund_to_consign.go:685 创建成 5", sale_types=["寄售"]),
 edge("X4","seller",None,"8","所有权变更 / 托管","系统", "transfer_ownership_change.go:59、transfer_managed_operation_ownership.go:69", sale_types=["寄售"]),
 edge("X5","seller",None,"5|2","来源创建即中间状态：大貔貅→5、TobApi/自营/ComeNoReturn→2","系统", f"{E}:1184,1250,1445、create_consign_for_*", sale_types=["寄售"], category_params=["创建即中间状态"]),
 edge("X6","seller","5","8","上门回收质检提交(PHP)","仓库", "PHP examining_report actions.class.php:2131-2132", sale_types=["寄售"]),
]

# ---------------- 回收单 ----------------
recycle_nodes = {
 "1":"估价中","2":"估价完成待寄出","3":"无法估价","4":"待取件","5":"待平台收货","6":"平台查验中","7":"查验完成待确认","8":"回收成功","9":"查验无法回收",
 "10":"未寄出用户取消","11":"已寄出用户取消","12":"已寄出超时未确认","13":"退回待寄出","14":"退回已寄出","15":"已退回","16":"未寄出超时","17":"删除",
 "18":"上门回收","19":"上门回收","20":"上门回收","21":"寄售转回收-估价中","22":"寄售转回收-待确认","23":"寄售转回收-超时","24":"寄售转回收-拒绝","25":"寄售转回收-价低","26":"寄售转回收-寄售单变化",
 "27":"仓库未收到","28":"送新取旧","29":"送新取旧","30":"送新取旧","31":"送新取旧","32":"送新取旧","33":"送新取旧","34":"送新取旧","35":"送新取旧","36":"捐赠","37":"已转寄卖",
}
recycle_meta = {
 "table": "ss_commodity.jiuwu_recycle_appraiser_order.status（T1 也可从 trade_jiuwu.jiuwu_recycle_appraiser_order 读 sn/status/appraiser_status）",
 "history_table": "ss_commodity.jiuwu_recycle_order_status_history(old_status,new_status,operation_info)",
 "enum_defs": ["product/jiuwu/lib/refactor/recycle/constant/RecycleAppraiserOrder.php", "product/ms-recycle/internal/constant/(27~37)"],
 "appraiser_status": {"1":"一次估价中","2":"一次失败","3":"一次完成","4":"二次估价中","5":"二次完成","6":"取消"},
 "self_test_entry": "PHP api_recycle/successRecycleTestEnvAction v1.0(sn+second_price→8+appraiser 5 并结算) / v2.0(sn+new_status→10/16/27/9/11/12)；lib/refactor/recycle/constant/RecycleMockData.php",
 "sn_note": "接口返回 sn 带 GJ 前缀，库里没有前缀",
 "unextracted": "17 删除 / 18-20 上门回收 / 27 仓库未收到 / 28-35 送新取旧 / 36 捐赠 未抽边（T1 历史里出现极少）；27 可用 successRecycleTestEnv v2 直达",
}
recycle_edges = [
 edge("R1","recycle",None,"1","提交估价","App","PHP JiuwuAppraiserOrderForm createOrder setAppraiserStatus(1)；App api_recycle/add", evidence="源码+数据(0→1 225)", recipes=["D-回收单-进行中-01","D-回收单-已下单待寄出-01"], factory=["trade /api/jiShou/recycle_other PhotoVal* / OnlineFirstPriceSave(鞋/服/包表配/数码各一套)"], category_params=["回收品类分线"]),
 edge("R2","recycle","0|1","2","出价完成(AI 价或估价师价)","估价师端 / 系统","api_recycle_appraiser/firstPriceSave、AppraiserPriceSaveService firstPriceSave→WAIT_DELIVERY", evidence="源码+数据(0→2 791，1→2 65)", recipes=["D-回收单-已下单待寄出-01"], factory=["trade OnlineFirstPriceSave"]),
 edge("R3","recycle","1","3","无法估价","估价师 / 定时","firstPriceSave FAILURE、autoFinishedFirstAppraiser", evidence="源码+数据(111)"),
 edge("R4","recycle","2","4","预约上门取件(取消取件 4→2)","App","取件单；api_seller/cancelPickup", evidence="数据(2→4 555，4→2 1979)"),
 edge("R5","recycle","4|2","5","揽收 / 自寄填单","物流回调 / App","updateRecycleReDeliveryInfoByOrderNumber WAIT_RECEIVE、api_recycle/updateSelfSendExpress", evidence="源码+数据(4→5 1279，2→5 582)", factory=["trade DigitalRecycleCreateShipped(数码，创建并发货，10-13 实测到 5)","鞋 step 内 SellerSendExpress"]),
 edge("R6","recycle","5","6","仓库入库","仓库","ms-black 入库(同卖家单 E3 链路)", evidence="源码+数据(1344)"),
 edge("R6x","recycle","6","6","仓内节点刷新(分拣/鉴定/一检/二检，同状态重复写历史)","仓库","唯一码节点", evidence="数据(578420)"),
 edge("R7","recycle","6|5","7","查验完成待确认","仓库质检","PHP examining_report executeRecycleReportSave；ms-black-inspection", evidence="源码+数据(6→7 909，5→7 92)", recipes=["D-回收单-查验完成待确认-01"], factory=["trade /api/jiShou/recycle 数码 SaveReport→SubmitPrice(10-13 实测 7/appraiser 5；SaveReport 单独不改主状态)","鞋 OnlineAssignRecycler(回收商估价+估价师确认)"], notes="DigitalRecycleDone 对已估价单报\"运营已操作不允许修改质检报告\"，7→8 要从新单独立跑或 successRecycleTestEnv v1"),
 edge("R8","recycle","7","8","用户确认回收","App","api_recycle/ackTask、RPC RecycleConfirm", evidence="源码+数据(569)", factory=["trade RecyclerDone / DigitalRecycleDone(需新单)","PHP successRecycleTestEnv v1.0"]),
 edge("R9","recycle","7","12|11","超时未确认 / 用户拒绝","定时 / App","超时 cron(具体 job 待核)", evidence="数据(241/81)", factory=["PHP successRecycleTestEnv v2.0 new_status=11/12"]),
 edge("R10","recycle","7","37","转寄卖出售","App","recycle_reject_to_consign.go:403 STATUS_CANCELLED_TO_CONSIGN", evidence="源码+数据(100)", coupling="回收⇄寄售", category_params=["回收拒绝转寄售的目标状态"]),
 edge("R11","recycle","5","9","查验无法回收","仓库","—", evidence="数据(33)", factory=["PHP successRecycleTestEnv v2.0 new_status=9"]),
 edge("R12","recycle","11","13→14→15","退回链","仓库 / 物流","appraiser_order.go:589 STATUS_RETURN_WAIT", evidence="源码+数据(71/7/7)"),
 edge("R13","recycle","2","16|10","超时未寄出 / 用户取消","定时 / App","CloseOrderService startScrub、RecycleTradeInTaskService；api_recycle/cancelRecycle", evidence="源码+数据(1168/567)", factory=["PHP successRecycleTestEnv v2.0 new_status=10/16"]),
 edge("R0","recycle",None,"21","寄售转回收：由寄售单生成回收单(估价中)","系统(ms-recycle 定时任务)","createSellConvertRecycleOrder", precondition="寄售单复审通过且有估价记录(jiuwu_recycle_valuation)", evidence="源码+数据(21→22 20)", recipes=["D-寄售单-寄售转回收前置-01"], factory=["supply /api/jiShou/consignToRecycle(10-13 寄售侧到 8+估价记录，回收单 15 分钟内未生成)"], coupling="回收⇄寄售"),
 edge("R14","recycle","21","22→8","寄售转回收：估价→待确认→成功","系统 / App","createSellConvertRecycleOrder、submitSellConvertRecycle", evidence="源码+数据(20/15)", recipes=["D-寄售单-寄售转回收前置-01","D-回收单-变现入口-01"], factory=["supply /api/jiShou/consignToRecycle firstAuditE2EService rid 2 recycleLevel S(10-13 寄售侧到 8+估价记录；回收单 21 待 ms-recycle 定时任务；鞋 rid 1 NPE)","supply RecycletoJishou"], coupling="回收⇄寄售"),
]

# ---------------- 买家单 ----------------
buyer_nodes = {"0":"订单生成","1":"未付款","2":"已付款未发货","3":"卖家已发货","4":"平台已发货","5":"已完成","6":"退款中","7":"已退款","8":"卖家取消","9":"买家取消","10":"平台查验中","11":"退货中","12":"商品未退回但不可退货退款","13":"待提货(潮玩一番赏)","14":"退货协商"}
buyer_meta = {
 "table": "trade_jiuwu.jiuwu_buyers_order.status", "enum_defs": ["infrastructure/ms-atom/biz/bizstatus/status.go:38-49"],
 "trace_table": "jiuwu_order_trace_node(node_code,node_time)",
 "order_type": {"1":"交易单","2":"转寄单"}, "sale_type": {"0":"默认","1":"拍卖","2":"降价拍"},
 "main_paths": {
  "挂售品(卖家在家发货)": "创建订单→等待卖家发货→卖家已发货→入库分拣→平台已收货→鉴别为真→质检查验→[发布问询→问询审核→买家接受/不接受]→发货核验→核验通过→打包完成→通知快递取件→出库→平台已发货→订单确认→交易完成",
  "在仓品(寄售已在仓)": "提交订单→打印拣货单→开始拣货→发货核验→出库→平台已发货→交易完成",
  "岔路": "创建→买家取消；卖家虚假发货；质检查验→平台查验不通过；退款中"},
 "t1_distribution": "9:3.2万 10:2.3万 5:1.7万 2:1.7万 6:1.6万 7:1.3万 13:5540(全潮玩 72)",
 "unextracted": "0 订单生成 / 8 卖家取消 / 12 不可退货退款 / 14 退货协商 未抽边",
}
buyer_edges = [
 edge("B1","buyer",None,"1","下单(未付款)","买家 App","order/ms-trade ordercal/submit/submitservice.go buildBuyerOrder Status 1", recipes=["D-购买订单-待付款-02","D-购买订单-待付款-01"], factory=["无寄售不付款场景(getOrderSubmit 只在商家直发/C2C 场景)；App 直通模式(touch ~/mock95/PASSTHRU)商详→立即购买→立即支付，10-13 实测 status 1"], notes="/api/trade/order 不适用；细狗 mitm 注入假加购项时 App 不发 submit，必须开 PASSTHRU；买家=卖家同号可下单"),
 edge("B2","buyer","1","2","支付回调","支付(T1 可 mock)","order/ms-order buyer_order_service.go BuyerPaid→2；同时卖家单 H3/E7", recipes=["D-购买订单-待发货-02","D-购买订单-待发货-01"], factory=["trade /api/trade/goods JiShouPricingBuyController(goodsId+buyerMobile，对已到 0/8 的寄售单一步 出价→下单→payMock，10-13 实测 10 秒到 2)","trade payMock buyerPayMockController(对已有未付单)","supply e2e waitCheckOutService(新建整链，有上架 job 时序坑：复审后 ~70 秒才到 8，接口不等就买会报 status 5)"], coupling="买家付款"),
 edge("B3","buyer","2","3","卖家发货","卖家 App","ms-order delivery/sellers_delivery.go SellerDelivery UpdateBuyerOrderStatus", factory=["trade GuaShouSellerExpressNewController","supply waitExecGuaWarehousingServiceE2E"]),
 edge("B4","buyer","3","10","入库","仓库","轨迹 BLACK_IN_WAREHOUSE；写入在 ms-black(待核)", evidence="数据", factory=["supply execGuaWarehousingServiceE2E"]),
 edge("B5","buyer","10|2","4","出库(平台已发货)","仓库","sellers_delivery.go FittingPlatformDeliver / GroupAuctionPlatformDeliver；PHP PlatformSendHandler:51", recipes=["D-购买订单-待收货-02","D-购买订单-待收货-01"], factory=["supply /api/jiShou/delivery checkOutService(sellerOrder 按单续推：下架→绑证书→发货核验→出库，10-13 实测 40 秒到 4，卖家单同时→3)","supply e2e deliveryFinishService/checkOutServiceE2E(新建整链)","挂售 guaDeliveryFinish→guaCheckOut"], notes="前置：卖家单 trade_number 非空(已购买)"),
 edge("B6","buyer","4","5","确认收货 / 自动","买家 App / 定时","ms-order order_confirm_service.go OrderConfirm→5；卖家单在出仓时已到 3(10-13 实证)", recipes=["D-购买订单-交易完成-02","D-购买订单-交易完成-01"], factory=["App：详情页点「确认收货」→二次确认弹窗再点「确认收货」(WDA predicate 匹配 4 个元素，取 rect.y 最小)，10-13 实测到 5","trade payMock seller72hDelaySettleController 仅 72h 无理由单"], coupling="买家确认收货"),
 edge("B7","buyer","1","9","取消未付款单","买家 App / 定时","ms-order cancel/c2c_app_cancel.go:483 cancelUnPayOrders", evidence="源码+数据(1449)", coupling="买家取消/售后"),
 edge("B8","buyer","2|10","6→7","售后退款","买家 App / 后台","order/ms-order-reverse refund_cancel.go、order_refund.go、fastrefund；卖家单回 0/8/5", recipes=["D-购买订单-售后中-01"], factory=["trade /api/trade/refundNew 8 场景","/v1/api/refund"], coupling="买家取消/售后"),
 edge("B9","buyer","10","11→7","查验不通过退货","仓库","ms-order-reverse black_refund_report.go", recipes=["D-购买订单-查验不通过-01"], factory=["ccc_refund_pass"]),
 edge("B10","buyer","2","13","潮玩一番赏自提待提货","系统","consignbuilder.go:73-75(买家 13→卖家子状态 2004)", evidence="源码+数据", category_params=["潮玩一番赏"], factory=["无(07 #26 真缺)"]),
]

couplings = [
 {"name":"买家付款","buyer":"1→2","seller":"挂售 0→1；寄售不变(子状态 2003)","impl":f"{E}:750 BuyerPaid，调用方 ms-pay / ms-trade","edges":["B2","H3","E7"]},
 {"name":"买家确认收货","buyer":"4→5","seller":"→3","impl":"ms-trade confirmSingleOrderReceipt→SellerOrderComplete","edges":["B6","E8","H6"]},
 {"name":"买家取消/售后","buyer":"→9/6/7","seller":"1→0 / →8 / →5","impl":f"{E}:1409、ms-order after_sale_cancel/*","edges":["B7","B8","E13a","E13b","E13c","H8"]},
 {"name":"回收⇄寄售","recycle":"7→37 / 21→22→8","seller":"回收拒绝转寄售新建 8 或 5(按品类)；回收转寄售 8/2；寄售转回收卖家单关闭","impl":"transfer_recycle_reject_to_consign.go:58-63、transfer_recycle_to_consign.go:145,182、recycle_reject_to_consign.go:403","edges":["R10","R14","X1","X2"]},
 {"name":"挂售⇄寄售","seller":"挂转寄(唯一码 3700)、流拍转寄售：sale_type 0/1→3 且状态 8","impl":f"{E}:1368 AuctionCancel、hang_to_consign_for_black_cmd.go","edges":["H10"]},
 {"name":"买家付款⇒我有资产","buyer":"1→2","have_asset":"自动新增 jiuwu_have_asset(source_type=1 order_no=买家单, asset_status=1 拥有中)；卖家单上架也同步一条 source_type=5(出售订单同步，无卖了换钱)","impl":"ms-goods-order repository/sellers_order.go publishHaveAssetSellCreate / MQ have_asset_change；表与枚举 product/ms-goods-biz/internal/globaldao/db/tables/jiuwu_have_asset.go","edges":["B2"],"recipes":["D-账号-我有可卖了换钱-01"]},
 {"name":"我有⇒卖了换钱⇒新卖家单","have_asset":"拥有中(source_type 1)","seller":"发布寄售/挂售，sell_source=1 buyer_resell，回写 have_asset.seller_order_number；售出后 asset_status 2","impl":"product/ms-goods-biz sale_process_common_util_service.go SOURCE_BUYER_RESELL；jiuwu_goods_resell_mapping","edges":["E1","H1"],"recipes":["D-账号-我有可卖了换钱-01"]},
]

categories = {"1":"鞋","2":"服饰","25":"箱包","26":"手表","35":"3C数码","70":"配件","71":"美妆","72":"潮玩","350":"运动户外","1011":"家具","1853":"童装","1946":"家电","2140":"童鞋","2193":"自营","2201":"书影音"}
condition = {"SSR":10,"SS":20,"S":40,"AA":50,"A":60,"B":80,"C":100,"未定":99}
category_params = [
 {"name":"回收拒绝转寄售的目标状态","decided_by":"根品类","effect":"服饰/童装/箱包/手表/配饰→8 待上架，其他→5 查验中","src":"transfer_recycle_reject_to_consign.go:58-63","edges":["X2","R10"]},
 {"name":"美妆临期","decided_by":"品类 71 + 保质期剩余天数<售卖期","effect":"子状态 6050 美妆待取回；个人寄售保质期限 120 天","src":"consignbuilder.go:51-65、ms-sale enum/consign.go BeautiesQuantityLimitDays","edges":["E4"],"factory":"无，要改保质期字段(07 #15)"},
 {"name":"3C 独立流程","decided_by":"品类 35 及子类","effect":"上架走 3C 分支、3C 质检 2610、3C 自营回收、3C 关单例外；造数走 supplyC / d1gital 专线，主线 e2e 对 rid 35 报错","src":"ccc_bs/shelves.go:80 IsSameThreeCFlow、finish_retrieval_ccc_merchant_cmd.go:60、unclose_order_for_3c.go","edges":["E4","E3x","R5","R7"]},
 {"name":"家电","decided_by":"品类 1946","effect":"上架分支","src":"ccc_bs/shelves.go:372 IsHouseAppliances","edges":["E4"]},
 {"name":"潮玩一番赏","decided_by":"品类 72 + 买家单 13","effect":"卖家子状态 2004 待买家提货","src":"consignbuilder.go:73-75","edges":["B10"]},
 {"name":"仓库质检自动通过","decided_by":"订单类型(寄售/挂售/貔貅/自营/回收)×品类(鞋可跳二检)","effect":"5 内部走多少节点","src":"ms-black/internal/basicservice/audit_bs/order_type.go:44-390","edges":["E3x"]},
 {"name":"上架门槛","decided_by":"成色已定 + 概况图数量(按品类配置)","effect":"5→8 能否发生","src":"shelves_for_sale_cmd.go check、shelves.go:138 GetMinPicNumber","edges":["E4"]},
 {"name":"创建即中间状态","decided_by":"来源：大貔貅→5、TobApi/自营/ComeNoReturn→2、转寄售→8","effect":"跳过 E1/E2","src":f"{E}:1184,1250,1445、create_consign_for_*","edges":["X5"]},
 {"name":"回收品类分线","decided_by":"造数工厂按品类分线","effect":"鞋/服饰/包表配/数码各一套 OnlineFirstPriceSave；包表配走 /recycle/other；服装回收 Clothes 版","src":"datafactoryservice trade RecycleShoesController/RecycleService","edges":["R1","R2"]},
]

factory_notes = {
 "base": "datafactoryservice：supply 10.217.8.230:8084 (env=t1) / trade :8096 (env=test1)；headers autotest:yes, dataSourceType:t1, X-Datafactory-Caller",
 "rule_new_vs_existing": "绝大多数 scene 是\"按手机号新建一张单跑到指定节点\"，不对已有单续推；吃单号的只有 supply /api/jiShou/supply、trade /api/tools/payMock(goodsid/ordernumber)、supply /api/jiShou/getBack、supply /api/tools/guaShouAudit、recycle step 场景(sellerOrderNumber)",
 "policy": ["1 接口优先：让业务代码自己推状态", "2 改表只改时间/价格/保质期等不碰状态的字段(工厂鉴别环节自己也走改表)", "3 插数据改状态是最后手段"],
 "helpers": "tools/datafactory/df.py 直调；tools/datafactory/t1q.py 核 T1 终态",
 "recipe_table": "飞书多维表 EKYmbTQ4za4UbJsS2t5cQ4aknuh / tblrZVesFOvjpDpM（81 条，配方id 形如 D-对象-状态-序号）",
}

sm = {
 "version": "2026-10-13",
 "source_docs": ["个人资产/项目/95分业务知识内化/05-寄售状态机试抽-20261012.md","06-个人出售三线状态机-20261012.md","07-造数工厂场景×状态机边对照-20261013.md","08-配方实测A结果-20261013.md"],
 "source_repo": SRC,
 "evidence_levels": {"源码":"读到实现","数据":"T1 日志/历史表统计出现过","推断":"未见实现"},
 "edge_kinds": {"normal":"正常推进边，路径搜索默认只用这类","bypass":"旁路创建边(X*)，直接创建成中间状态，how 单独列出","rollback":"售后/取消把单打回的边，依赖另一张图的动作，路径搜索默认不用"},
 "graphs": {
  "seller": {"title":"卖家单(寄售/挂售/拍卖)","meta":seller_meta,"nodes":seller_nodes,"edges":seller_edges},
  "recycle": {"title":"回收单","meta":recycle_meta,"nodes":{k:{"name":v} for k,v in recycle_nodes.items()},"edges":recycle_edges},
  "buyer": {"title":"买家单","meta":buyer_meta,"nodes":{k:{"name":v} for k,v in buyer_nodes.items()},"edges":buyer_edges},
 },
 "couplings": couplings,
 "categories": categories, "condition": condition, "category_params": category_params,
 "factory": factory_notes,
}
out = pathlib.Path(__file__).with_name("fen95_state_machine.json")
out.write_text(json.dumps(sm, ensure_ascii=False, indent=1), encoding="utf-8")
n = sum(len(g["edges"]) for g in sm["graphs"].values())
print(f"wrote {out} nodes={sum(len(g['nodes']) for g in sm['graphs'].values())} edges={n}")
