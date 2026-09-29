# 设计：飞书项目数字员工

## 一、全景

```
飞书项目 AI 节点（nine-prd-review 等）
  │ 8001 running / 8004 rollback（webhook）
  ▼
meegle-hook（细狗，经 CF 隧道 meegle-hook.heasenbug.com）
  │ 验签、去重、按 employee.json 的 nodes 找员工；8004 且停在 done → ai_node/edit 置回 running
  │ POST 127.0.0.1:19877/meegle/dispatch {employee, work_item_id, state_key, flow_id, text}
  ▼
NanoClaw（细狗实例）
  │ 虚拟群 jid = meegle:<employee>:<work_item_id>，folder = emp-<employee>-<work_item_id>
  │ 不存在则 registerGroup（standalone + sharedOneCLIAgent + env + customCwd=员工目录）
  │ storeChatMetadata + storeMessage + enqueueMessageCheck
  ▼
agent（独立模式，cwd = 员工目录）
  │ 读 员工 CLAUDE.md + 员工 skills + assets/
  │ 用 meegle-np / meegle-ainode / lark-cli --profile <员工> 干活（全部应用身份）
  │ 正式产出 → 飞书项目评论/字段（硬门禁）；心得 → assets/
  ▼
MeegleChannel.sendMessage → 镜像到员工观察群（fs:oc_...），首行标 [员工·需求ID]
```

## 二、员工目录约定

`EMPLOYEES_DIR`（.env，细狗默认 `~/ai/employees`）下每个员工一个目录：

```
~/ai/employees/prd-review/
  employee.json      # 清单（见下）
  CLAUDE.md          # 职责、SOP、红线；独立模式下这是唯一的"人设"
  .claude/skills/    # 专属 skill（cwd 下 project 级 skills，SDK 直接加载）
  assets/            # 员工自己的资产：index.md + 经验/踩坑/原子块，执行中自己追加
  bin/               # 员工专用命令封装（如 lark-cli 固定 --profile）
```

`employee.json`：

```json
{
  "id": "prd-review",
  "name": "PRD 评审员",
  "nodes": [{"project_key": "6ab9e7e22298e75d1ddf7cf7", "state_key": "ai_review"}],
  "observe_jid": "fs:oc_5d413755f2b4e3b91b3749d514e5969a",
  "skills": ["nine-refine-product"],
  "env": {"LARK_CLI_PROFILE": "prd-review"}
}
```

目录放在 NanoClaw 树之外：SDK `settingSources: ['project']` 会沿 cwd 父链加载 CLAUDE.md，放在 `groups/` 下会把 `groups/CLAUDE.md` 和 nanoclaw 根 CLAUDE.md 一起带进来（调研 5）。

## 三、会话 = 员工 × 需求

- 会话按 folder 存（sessions 表主键 group_folder，调研 3），folder 在 registered_groups 里 UNIQUE，所以每个"员工 × 需求"一个虚拟群、一个 folder。
- folder 命名 `emp-<employee>-<work_item_id>`，满足 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。
- 同一需求被退回、重新进入节点：hook 带同一 work_item_id → 命中同一 folder → `sessions[folder]` 续接（resume），员工记得上一轮。
- transcript 路径由 cwd 决定（`encodeClaudeProjectPath(cwd)`）；所有会话 cwd 都是员工目录，但 CLAUDE_CONFIG_DIR 按 folder 分开，互不串。
- 员工级共享通过 cwd：同一员工所有会话读写同一个 `assets/`，这就是"越做越准"的载体。

## 四、独立模式（containerConfig.standalone = true）

| 位置 | 改动 |
| --- | --- |
| `resolveWorkspacePaths`（container-runner.ts:407） | 不传 `global` → agent-runner 跳过 SOUL/TOOLS/全局 CLAUDE.md（各注入点已有 `globalDir &&` 判断） |
| `computeExtraDirs`（agent-runner index.ts:773-782） | 只保留员工目录，不推 groups/、nanoclaw 根、NANOCLAW_PERSONAL_DIR |
| `prepareGroupSession` skills 同步（container-runner.ts:443-452） | 不同步 container/skills；员工 skills 在 `<员工目录>/.claude/skills`（见下方实测），白名单公共 skill（如 meegle、lark-doc）由派活入口拷进去 |
| `buildLocalEnv`（container-runner.ts:676） | 不设共享 memory override |
| `injectMemory`（index.ts:1639-1651） | 跳过 |
| `customCwd` | 指向员工目录，避开 NANOCLAW_DEFAULT_CWD |

已实测（09-29）：`settingSources: ['project']` 时 `CLAUDE_CONFIG_DIR/skills` 不加载、`<cwd>/.claude/skills` 加载。所以员工 skills 放 `<员工目录>/.claude/skills/`，独立模式下不再往会话目录同步 container/skills；employee.json 白名单里的公共 skill 由派活入口拷进员工 `.claude/skills`。

## 五、共享 OneCLI 账号组（containerConfig.sharedOneCLIAgent = true）

- `ensureOneCLIAgent`（index.ts:209）：跳过，不在 metal 建 per-group agent。
- `getAgentAccessToken`（container-runner.ts:601-603）：直接用 `getContainerConfig` 的 Default token，不做替换。
- `rotateAccount` 所有调用点（index.ts:1379/1888/1977、task-scheduler.ts:286）：shared 群直接 return null。切号交给 metal 网关（9 个号绑 Default Agent）。
- 顺手清理：细狗 09-29 已在 metal 建出的空 agent `grp-fsocfe784cbf…`，实现后手动删（需大杰确认，metal 是生产 OneCLI）。

## 六、CLI 与身份（大杰 09-29 拍板：一律应用身份）

- 飞书项目：meegle-np（业务读写）+ meegle-ainode（AI 节点，插件凭证，随用随换，不过期）。
- 飞书：`lark-cli profile add` 为员工建 profile（应用 ID/Secret），调用加 `--profile <员工> --as bot`；员工 `bin/lark` 封装固定这两个参数。
- 不给员工开个人飞书账号，没有用户令牌过期问题。评论署名仍是插件绑定的 user_key，靠评论首行【节点名】标记区分 AI 产出。

## 七、输出路由

- 正式产出只走 CLI 写回（评论 + 字段 + 节点流转），沿用 `meegle-ainode comment/done/stop` 硬门禁。
- agent 最终回复 → `MeegleChannel.sendMessage(jid, text)` → 解析 employee → `observe_jid` 的飞书群，首行 `[PRD 评审员 · 需求 7126683372]`。观察群只看不驱动。
- 问题卡片等强转 FeishuChannel 的路径（index.ts:1210/2652/2693/2718）：虚拟群不支持，员工 CLAUDE.md 明确"不发问题卡片，问题写评论"。

## 八、自我进化

- 员工 CLAUDE.md 规定：每次运行结束前，若出现"被退回 / 被人纠正 / 新踩的坑 / 判断依据变化"，追加到 `assets/`（一条一文件 + 更新 `assets/index.md`），每次运行开始先读 index。
- 大杰 09-29 拍板：定期看。实现一个每周定时任务，把本周 assets 新增/修改汇总发到观察群。
- 资产目录纳入 git（细狗本地仓库），每次追加自动 commit，出问题可回滚。

## 九、回调迁到细狗

1. 细狗 `cloudflared tunnel login`（大杰授权一次）→ 复用隧道 meegle-hook（拷凭证 json）或新建同名路由；Mac mini 上的 tunnel 与 server launchd 停掉。
2. meegle-hook 代码仓库在细狗 git clone（不 scp）；ROUTES 改为读 `EMPLOYEES_DIR/*/employee.json` 的 nodes。
3. dispatch 目标从 debug `/send` 改为 `/meegle/dispatch`。
4. 细狗到飞书的 DNS 已修（Clash nameserver-policy），回调入站走 CF 隧道，不受影响。

## 十、并发与清理

- 全局并发沿用 MAX_CONCURRENT_AGENTS；员工级并发第一版不做（见 tasks 3.2b）。
- 需求走到结束节点（8003 且为最后一个 AI 节点，或手动）→ 标记虚拟群归档：保留 transcript，不再续接；定期清理 90 天前归档的会话目录。

## 十一、不做

- 不改飞书项目流程编排（仍在飞书项目后台配）。
- 不给员工独立飞书账号。
- 不迁移 Mac mini 上现有 review 群的 SOP 群机制；新机制在细狗验收后再下线旧的。
