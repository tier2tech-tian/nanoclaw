# traffic-light-autonomy Specification

## Purpose
TBD - created by archiving change kickoff-traffic-light-autonomy. Update Purpose after archive.
## Requirements
### Requirement: 动作级红灯清单
kickoff SKILL.md MUST 内置一份动作级红灯清单，灯色判定 MUST 以清单命中为准，不得让模型现场解释"不可逆/有风险"等抽象标准。清单 MUST 至少包含：
1. 删除/覆盖非本任务产生的用户资产或生产数据
2. 改 DB schema / 数据迁移
3. 对外发布：发消息到本群之外、公开渠道发布、发版本、部署生产
4. 花钱或开付费资源
5. 合并 PR 到共享分支（项目规则/记忆明确授权自主合的除外）
6. 修改协作协议母版、SOUL.md、个人资产目录结构
7. 范围变更：做需求外的事、降低验收标准
8. 不可逆 git 操作（force push、删远端分支）
9. 重启共享服务（如 NanoClaw 主进程）
10. 对生产/共享机器的状态变更操作（SSH 执行写命令、改配置、docker 变更；只读诊断除外）
11. 创建/修改/取消定时任务（会在离场后持续产生副作用）

清单未命中时 MUST 追加三问兜底：不可逆吗？花钱吗？对本群之外产生他人可见的副作用吗（消息/发布/外部系统写入；驾驶舱、项目看板、worktree 等既定工作流写入不算）？——任一为是即红灯。

#### Scenario: 清单命中即红
- WHEN 方案中某动作命中红灯清单任一条（如需要合并 PR 到共享分支）
- THEN 该动作 MUST 判为红灯，进入挂账流程

### Requirement: 三级灯色定义可操作
SKILL.md MUST 给出三级灯色的可操作定义，不得只定义红灯：
- 🔴 红灯 = 命中红灯清单或三问兜底的动作
- 🟡 黄灯 = 非红灯、但需要在多个合理选项间自主拍板（选方案/改流程/动共享配置），或有轻微可逆影响的动作；义务 = 判级理由当场记驾驶舱
- 🟢 绿灯 = 材料齐、路径明确的既定流程推进；义务 = 直接干，无额外留痕

#### Scenario: 黄灯义务可触发
- WHEN Agent 在两个合理技术方案间自主选定其一
- THEN 该决策 MUST 判为黄灯并把判级理由记入驾驶舱

### Requirement: 红灯依赖链一并挂账
绿/黄灯动作若**依赖**某个红灯动作的结果（如实现依赖挂账中的 DB 迁移、E2E 依赖挂账中的 PR 合并部署），该下游动作 MUST 随红灯一起挂账并标明依赖链；只有能独立完成的部分才继续推进。

#### Scenario: 下游依赖随挂
- WHEN DB 迁移判红挂账，而代码实现必须建立在迁移之上
- THEN 实现部分随迁移一起挂账（标明"依赖迁移拍板"），其余独立部分（如文档、纯函数）继续

#### Scenario: 清单命中判红
- WHEN 方案中某动作命中红灯清单任一条（如需要执行 DB 迁移）
- THEN 该动作 MUST 判为红灯并进入挂账流程，不得直接执行

#### Scenario: 拿不准升一级
- WHEN 某动作灯色无法确定（绿黄之间、黄红之间）
- THEN MUST 按更高一级处理（绿疑升黄、黄疑升红）

### Requirement: 灯色分流替换确认 Gate
kickoff 轨道 A 的 A3 与轨道 B 的 B5→B6 衔接 MUST 由「等用户确认」改为灯色分流：方案产出并汇报后，对方案内每个执行动作判灯色——全部绿/黄 MUST 直接进入实现（含 Step 3.5.2/3.5.3 状态推进与开 worktree）；黄灯决策 MUST 把判级理由当场记入驾驶舱。

#### Scenario: 全绿黄直接实现
- WHEN 轨道 B 完成 B5 汇报且方案所有动作均为绿/黄灯
- THEN MUST 不等待用户回复，直接执行 3.5.3 推进开工态并进入实现

#### Scenario: 黄灯留痕
- WHEN 某动作判为黄灯并自主决策（如选定方案 A 而非 B）
- THEN 驾驶舱 MUST 当场追加判级理由与依据

### Requirement: 红灯挂账不阻塞
方案中含红灯动作时，红灯部分 MUST 挂账（记录背景+选项+建议进驾驶舱「待大杰」），其余绿/黄部分 MUST 继续推进，最终汇报 MUST 用「需要你决定」段集中呈现挂账项。红灯项在大杰拍板前 MUST NOT 执行。

#### Scenario: 混合灯色任务
- WHEN 方案含 1 个红灯动作（如改 DB schema）+ 若干绿黄动作
- THEN 绿黄动作实现完成，红灯动作以背景+选项+建议形式挂账，汇报中集中列出

### Requirement: 实现后自 review 双运行时可执行
所有依赖子 agent 的评审步骤（kickoff B3 方案评审、implement Step 3b 代码审查、Step 4 测试审查）MUST 有无 Agent 工具运行时（Codex 等）的 fallback：按同一评审标准/checklist 逐项自查输出结论，或走 codex review 插件。fallback 规则 MUST 在 kickoff 自主分级章节写一份，implement 各步引用，不得让 Codex 运行时静默跳过任何评审。

#### Scenario: Codex 运行时评审不缺席
- WHEN Codex 模式执行到 kickoff B3 / implement Step 3b / Step 4 任一评审步骤
- THEN MUST 按 checklist 逐项自查并输出评审结论，不得跳过

### Requirement: ship 快速通道对齐红灯清单
ship SKILL.md 的「高风险改动分步走」判据 MUST 显式引用 kickoff 的红灯清单：命中红灯清单的动作即使在 ship 快速通道中也 MUST 挂账等拍板，ship 不构成绕过红灯的旁路。

#### Scenario: ship 遇红灯
- WHEN ship 流程中某动作命中红灯清单（如 DB 迁移）
- THEN 该动作挂账等拍板，与 kickoff 轨道行为一致

### Requirement: E2E 用例自设计自执行并按思路+列表+结果汇报
implement Step 5.5 MUST 改为：Agent 自行设计 E2E 用例并自行执行（不再等大杰确认后执行），最终汇报 MUST 包含三部分：总体用例设计思路（覆盖策略、回归范围）、具体用例列表（场景/触发方式/预期结果）、逐条执行结果。用例执行本身按灯色规则判定——含红灯动作（如向外部群发消息）的用例 MUST 挂账。

#### Scenario: 用例自动执行并汇报
- WHEN 实现完成且改动有外部可观测行为
- THEN Agent 设计用例表→逐条执行→汇报中输出思路+列表+结果，全程不等确认

#### Scenario: 含红灯动作的用例
- WHEN 某 E2E 用例需要向其他群发真实消息
- THEN 该用例 MUST 挂账等拍板，其余用例正常执行

### Requirement: PR 合并保持红灯
implement Step 6 的 PR 合并确认 gate MUST 保留：合并到共享分支属红灯清单固定项，MUST 等大杰确认（项目规则/记忆明确授权自主合并的项目除外，且任何情况下禁止 `--auto` 与未经授权的 squash）。

#### Scenario: 实现完成后停在 PR
- WHEN 绿黄灯任务实现、自 review、E2E 全部完成
- THEN 提 PR + 完整汇报，合并动作等大杰说"合"

