## Why

大杰要把飞书项目的研发流程改造成"飞书项目编排流程 + 数字员工执行节点"：流程走到某个 AI 节点，平台回调，由这个节点专属的数字员工去干活（如 AI 需求评审 = PRD 评审员工），干完写回飞书项目并推进节点。细狗（xigou）作为数字员工的专用机器。

现状的 NanoClaw 是"一个飞书群 = 一个会话 = 大狗人格 + 全部公共 skill"，满足不了三点：

1. **员工要专属**：每个员工只带自己的规则、skill、CLI 配置和资产目录，不带大狗人格和全局规则。
2. **会话按需求划分**：一个员工同时处理 N 个需求，一个需求一个会话；需求被退回再次进入时要接着原会话，记得上一轮说过什么。
3. **员工自己进化**：执行中踩到的坑、被纠正的判断，员工自己写进自己的资产目录，下次读到。

2026-09-29 已跑通的前置：飞书项目 AI 节点应用 nine-prd-review、回调服务 meegle-hook（Mac mini）、细狗 NanoClaw 实例（metal OneCLI 共享账号池）、review 群按 SOP 评审并写正式评论的硬门禁。

## What Changes

- **员工定义**：新增员工目录约定 `EMPLOYEES_DIR/<employee>/`（CLAUDE.md + skills/ + assets/ + bin/ + employee.json），放在 NanoClaw 目录树之外，避免 cwd 父链加载大狗的 CLAUDE.md。
- **飞书项目来源（MeegleChannel）**：新增 jid 前缀 `meegle:<employee>:<work_item_id>`。每个"员工 × 需求"注册为一个虚拟群（独立 folder = 独立会话），同一需求再次进入复用同一 folder，自动续接会话。
- **派活入口**：NanoClaw 新增本机 HTTP 入口 `POST /meegle/dispatch`，回调服务调用它；入口负责按需注册虚拟群、写消息、唤醒队列。
- **独立模式**（`containerConfig.standalone`）：不加载 SOUL/TOOLS/全局 CLAUDE.md、不挂 groups/ 与 nanoclaw 根与个人资产目录、不注入动态记忆、skills 只同步员工自己的。
- **共享 OneCLI 账号组**（`containerConfig.sharedOneCLIAgent`）：不为虚拟群建 per-group agent，直接用 Default Agent，拦住按群切号。修掉"每注册一个群就在 metal 建一个空账号组"的问题。
- **按群附加环境变量**（`containerConfig.env`）：员工的 CLI profile、PATH（员工 bin/ 在前）等。
- **输出路由**：员工的正式产出只通过 CLI 写回飞书项目（沿用 `meegle-ainode comment` 硬门禁）；agent 的对话回复镜像到该员工的观察群，供大杰旁观。
- **回调迁到细狗**：meegle-hook 服务与 Cloudflare 隧道 `meegle-hook.heasenbug.com` 迁到细狗，按 `employee.json` 里声明的节点路由，改调 `/meegle/dispatch`。

## Capabilities

### New Capabilities
- `digital-employee`: 员工目录约定、employee.json 清单、独立模式、资产目录自我进化约定
- `meegle-channel`: 飞书项目虚拟来源、按需求划分会话、派活入口、输出镜像

### Modified Capabilities
- OneCLI 账号选择：新增共享 Default Agent 开关
- ContainerConfig：新增 `standalone` / `sharedOneCLIAgent` / `env` / `employee` 字段

## Impact

- **src/types.ts**：ContainerConfig 新字段
- **src/channels/meegle.ts**（新）：MeegleChannel
- **src/meegle-dispatch.ts**（新）：派活入口、虚拟群注册
- **src/container-runner.ts**：resolveWorkspacePaths（standalone 不传 global）、prepareGroupSession（skills 白名单）、buildLocalEnv（合并 env、sharedOneCLIAgent）
- **src/index.ts**：ensureOneCLIAgent / rotateAccount 调用点跳过 shared 群；standalone 群跳过 injectMemory
- **container/agent-runner/src/index.ts**：computeExtraDirs 在 standalone 下只保留员工目录
- **兼容性**：全部新行为由 containerConfig 字段显式开启，现有群零影响；不改表结构（ContainerConfig 本来就是 JSON 列）
- **部署**：只在细狗实例启用；Mac mini 大狗不受影响
