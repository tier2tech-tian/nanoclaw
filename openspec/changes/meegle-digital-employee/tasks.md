# 任务拆分

## 0. 先验（不改代码）
- [ ] 0.1 实测 `settingSources: ['project']` 下 `CLAUDE_CONFIG_DIR/skills` 是否加载 → 决定员工 skills 放置位置
- [ ] 0.2 实测 lark-cli `profile add` + `--profile x --as bot` 在细狗可用（应用身份发一条消息到观察群）

## 1. ContainerConfig 与共享 OneCLI（独立 PR，可先合）
- [ ] 1.1 types.ts：`standalone` / `sharedOneCLIAgent` / `env` / `employee` 字段
- [ ] 1.2 sharedOneCLIAgent：ensureOneCLIAgent、getAgentAccessToken、rotateAccount 四个调用点
- [ ] 1.3 env 合并进 buildLocalEnv（PATH 前插员工 bin/）
- [ ] 1.4 单测：shared 群不建 agent、不切号、token 取 Default；env 合并不覆盖 OneCLI 代理变量

## 2. 独立模式
- [ ] 2.1 resolveWorkspacePaths 不传 global；computeExtraDirs 只留员工目录
- [ ] 2.2 skills 白名单同步；跳过 memory override / injectMemory
- [ ] 2.3 单测 + 实测：独立群 system prompt 不含 SOUL/TOOLS 内容，skills 列表只有白名单

## 3. MeegleChannel 与派活入口
- [ ] 3.1 src/channels/meegle.ts：ownsJid(meegle:)、sendMessage 镜像到 observe_jid
- [ ] 3.2 src/meegle-dispatch.ts：POST /meegle/dispatch（127.0.0.1），按需 registerGroup（folder/customCwd/containerConfig 由 employee.json 生成）、storeChatMetadata、storeMessage、enqueue；员工级并发
- [ ] 3.3 员工清单加载器：扫描 EMPLOYEES_DIR/*/employee.json，校验字段
- [ ] 3.4 单测：同一 work_item 两次 dispatch 命中同一 folder；不同 work_item 不同 folder

## 4. 回调迁移（细狗）
- [ ] 4.1 meegle-hook 仓库推 GitHub 私有仓，细狗 clone
- [ ] 4.2 ROUTES 改读 employee.json；dispatch 改调 /meegle/dispatch
- [ ] 4.3 CF 隧道迁到细狗（大杰授权 cloudflared login），停 Mac mini 上的 server/tunnel

## 5. 第一个员工：prd-review
- [ ] 5.1 员工目录：CLAUDE.md（由现 review 群 SOP 改写，去掉群相关）、skills（nine-refine product 阶段）、assets/index.md、bin/
- [ ] 5.2 E2E：tian-测试建需求 → 推到 AI 需求评审 → 细狗员工评审、写正式评论 → 需澄清/不通过/通过三条路径各走一遍；退回再进入验证会话续接
- [ ] 5.3 每周资产汇总定时任务

## 6. 收尾
- [ ] 6.1 下线 Mac mini review 群 SOP 派活
- [ ] 6.2 清理 metal 上细狗建出的空 OneCLI agent（需确认）
- [ ] 6.3 wiki + 原子块
