# 任务拆分

## 0. 先验（不改代码）
- [x] 0.1 实测（09-29 细狗 SDK 探针）：`settingSources: ['project']` 下 `CLAUDE_CONFIG_DIR/skills` **不加载**，`<cwd>/.claude/skills` **加载** → 员工 skills 放 `<员工目录>/.claude/skills/`
- [x] 0.2 实测：细狗 `lark-cli profile add --name prd-review`（不 --use，不动已有 Thrall profile）+ `--profile prd-review --as bot` 读群列表成功

## 1. ContainerConfig 与共享 OneCLI（独立 PR，可先合）
- [x] 1.1 types.ts：`sharedOneCLIAgent` / `env`（`standalone` 放第 2 步、员工信息由 3.2 派活入口生成 containerConfig，不单独加 `employee` 字段）
- [x] 1.2 sharedOneCLIAgent：ensureOneCLIAgent 跳过；getAgentAccessToken 不替换；rotateAccount 四个调用点经 `canAutoRotateGroupAccount` 统一拦住
- [x] 1.3 env 合并进 buildLocalEnv（`mergeGroupEnv`：PATH 前插，代理/证书/会话目录/NANOCLAW_* 受保护）
- [x] 1.4 单测（缺陷注入验证：去掉 shared 判断或 PATH 前插，3 条测试失败）：shared 群不建 agent、不切号、token 取 Default；env 合并不覆盖 OneCLI 代理变量

## 2. 独立模式
- [x] 2.1 resolveWorkspacePaths 不传 global；computeExtraDirs 只留员工目录
- [x] 2.2 standalone 不同步 container/skills 到会话目录（员工 skills 在 `<员工目录>/.claude/skills`，白名单公共 skill 由派活入口拷进去）；跳过 memory override / injectMemory
- [x] 2.3 单测 + 实测（09-29 细狗：员工会话 transcript 无 SOUL/大狗内容，只用 meegle-emp/lark）：独立群 system prompt 不含 SOUL/TOOLS 内容，skills 列表只有白名单

## 3. MeegleChannel 与派活入口
- [x] 3.1 src/channels/meegle.ts：ownsJid(meegle:)、sendMessage 镜像到 observe_jid
- [x] 3.2 `src/meegle-employees.ts` + debug API `POST /meegle/dispatch`（127.0.0.1:19877），按需 registerGroup（folder/customCwd/containerConfig 由 employee.json 生成，独立模式不拷全局 CLAUDE.md 模板）、storeChatMetadata、storeMessage、enqueue
- [ ] 3.2b 员工级并发（`max_concurrent`）：暂不做，先靠全局 MAX_CONCURRENT_AGENTS；需要时在 message loop 按员工限流
- [x] 3.3 员工清单加载器：扫描 EMPLOYEES_DIR/*/employee.json，校验字段
- [x] 3.4 单测：同一 work_item 两次 dispatch 命中同一 folder；不同 work_item 不同 folder

## 4. 回调迁移（细狗）
- [ ] 4.1 meegle-hook 仓库推 GitHub 私有仓，细狗 clone
- [ ] 4.2 ROUTES 改读 employee.json；dispatch 改调 /meegle/dispatch
- [ ] 4.3 CF 隧道迁到细狗（大杰授权 cloudflared login），停 Mac mini 上的 server/tunnel

## 5. 第一个员工：prd-review
- [x] 5.1 员工目录（细狗 ~/ai/employees/prd-review，git 管理；工具 bin/meegle-emp 纯插件凭证，替代依赖个人登录的 meegle-np）：CLAUDE.md（由现 review 群 SOP 改写，去掉群相关）、skills（nine-refine product 阶段）、assets/index.md、bin/
- [ ] 5.2 E2E（09-29 已验：本机派活→员工评审→识别重复批次不重复评论→自记经验并 commit；待验：新需求三条结论路径、写评论接口、退回续接）：tian-测试建需求 → 推到 AI 需求评审 → 细狗员工评审、写正式评论 → 需澄清/不通过/通过三条路径各走一遍；退回再进入验证会话续接
- [ ] 5.3 每周资产汇总定时任务

## 6. 收尾
- [ ] 6.1 下线 Mac mini review 群 SOP 派活
- [ ] 6.2 清理 metal 上细狗建出的空 OneCLI agent（需确认）
- [ ] 6.3 wiki + 原子块
