# 95分 业务状态机（agent 可查）

把卖家单（寄售 / 挂售 / 拍卖）、回收单、买家单三张状态机合成一份 JSON，每条边带：谁推、前置条件、源码位置、App 子状态文案、证据等级、品类分支、造数工厂场景、配方表 id。来源是 `个人资产/项目/95分业务知识内化/05~08` 四份文档，源码在细狗 `~/code/mothership/server`。

## 文件

- `build_sm.py` — 唯一真值，改图改它，跑一遍重新生成 JSON。
- `fen95_state_machine.json` — 生成物，agent 直接读。
- `smq.py` — 查询 CLI，加 `--json` 给 agent 用。

## 用法

```bash
python3 smq.py graphs                       # 三张图概览
python3 smq.py nodes seller                 # 卖家单 11 个状态 + App 文案
python3 smq.py node seller 5                # 状态详情：进边/出边/配方
python3 smq.py edge E10                     # 边详情
python3 smq.py how seller 9 35              # 造一张"数码寄售取回中"的单：路径+每步工厂场景+配方+品类注意
python3 smq.py how seller 1 2 挂售          # 挂售待发货（第 3 个参数是品类 rid，第 4 个是类型）
python3 smq.py path recycle new 8           # 回收单从创建到回收成功的最短路径
python3 smq.py search 取回                  # 关键词搜
python3 smq.py couplings                    # 三图耦合边
```

## 规则

- 边分三类：`normal` 正常推进（路径搜索默认只用它）；`bypass` 旁路创建（X*，直接创建成中间状态，how 单独列出）；`rollback` 售后/取消打回（依赖另一张图的动作，不进路径搜索）。
- seller 图路径默认按寄售过滤，挂售 / 拍卖要显式传类型；拍卖的创建边没抽，`path seller new 3 拍卖` 会报无路径。
- `to` 写成 `13→14→15` 表示链，链上每个状态都算该边可达；`0|5|8` 表示任一。
- 证据等级：源码 = 读到实现；数据 = T1 日志 / 历史表统计出现过；推断 = 未见实现。推断档的边不要当事实用。
- 未抽边的状态：回收 17/18-20/27/28-36，买家 0/8/12/14（见各图 meta.unextracted）。

## 造数三级策略（大杰 10-13 定）

接口优先 → 改表只改时间 / 价格 / 保质期这类不碰状态的字段 → 插数据改状态是最后手段。直调和核验脚本在 `../datafactory/`。
