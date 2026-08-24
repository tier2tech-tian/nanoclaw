# Proposal: kickoff 红黄绿灯自主推进改造

## Why

当前 kickoff 的轨道 A（A3）和轨道 B（B5/B6）在方案产出后一律停下等大杰确认才能动手，与协作协议 v1.1 的「红黄绿灯自主边界」不一致：绿/黄灯项也被迫等待，打断自主推进节奏，大杰被动成为流程瓶颈。协议里"挂账不阻塞"机制已有，skill 投影层没接上。

## What Changes

- **kickoff SKILL.md**：
  - 新增「自主分级（红黄绿灯）」章节：**动作级红灯清单**（不留给模型现场发挥抽象标准）+ 「拿不准升一级」硬规则 + 黄灯判级理由必须记驾驶舱
  - 轨道 A 的 A3「等待确认」→ 改为**灯色分流**：修复动作全绿/黄 → 直接进入修复；含红灯动作 → 红灯部分挂账、其余继续
  - 轨道 B 的 B5「等你确认后开始写代码」/ B6「用户确认后」→ 改为汇报后**灯色分流直接进实现**，红灯项挂账不阻塞
  - Step 3.5.3 的触发措辞同步（"获准实现后" → "灯色分流通过后"）
  - 自 review 的 **Codex fallback** 写明：无 Agent 工具时按评审 checklist 自查或走 codex review 插件
- **implement SKILL.md**（连带，否则新流程在下游断掉）：
  - Step 5.5 E2E 用例从「表发给大杰、确认后执行」→ **自己设计、自己执行**，汇报时输出「总体设计思路 + 具体用例列表 + 逐条结果」
  - Step 6 **PR 合并保留等确认**（合并到共享分支 = 红灯清单固定项），汇报格式增加 E2E 设计思路段
- **ship SKILL.md**（连带小改）：「高风险改动→分步走」判据显式引用红灯清单，堵住绕过红灯的旁路；其余不动（PR 合并等确认本来就保留）。
- **不改**：协作协议母版（skill 是投影，协议本来就是红黄绿灯）、开工三项确认（保留，大杰唯一必看检查点）、wrapup skill。

## Capabilities

### New Capabilities
- `traffic-light-autonomy`: kickoff/implement 工作流的红黄绿灯自主分级——红灯清单判定、灯色分流、挂账不阻塞、黄灯判级留痕、自 review 双运行时 fallback、E2E 用例自设计自执行并按「思路+列表+结果」汇报。

### Modified Capabilities
（openspec/specs/ 下无 kickoff/implement 相关已有 spec，全部为新增。）

## Impact

- `container/skills/kickoff/SKILL.md`（A2 模板末行、A3、B3 fallback、B5、B6、3.5 前言、3.5.3、新增分级章节）
- `container/skills/implement/SKILL.md`（Step 3b/4 评审 fallback 引用、Step 5.5、Step 6 汇报格式）
- `container/skills/ship/SKILL.md`（高风险判据引用红灯清单）
- 两运行时同时生效（Claude SDK 走 Skill 工具 / Codex 直接 Read 同一文件），无代码、无 DB、无 API 变更
- 风险面：灯色误判导致未经确认执行了该确认的动作——靠动作级清单 + 升级规则 + 驾驶舱留痕收敛
