# Codex账号配置与平滑切换

`codex`、`codex-as`群共用这套账号管理；Claude账号继续使用原OneCLI路径。默认不配置任何文件即可沿用现有系统账号。

## 配置账号

系统账号名称固定为`system`，授权源是运行NanoClaw用户的`~/.codex/auth.json`，不会复制、迁移或覆盖它。

在`~/.config/nanoclaw/codex-accounts.json`登记自定义账号；也可通过NanoClaw启动环境变量`NANOCLAW_CODEX_ACCOUNTS_FILE`指定注册表位置。

```json
{
  "accounts": [
    { "name": "backup", "authFile": "~/.codex-accounts/backup/auth.json" },
    { "name": "work", "authFile": "~/.codex-accounts/work/auth.json" }
  ]
}
```

注册表只有名称和路径，不放token。名称不区分大小写匹配，支持字母、数字、下划线与连字符；`system`、`auto`、`all`、`delete`保留，重复名称拒绝。路径必须绝对或以`~/`开头。

每个自定义账号须在独立`CODEX_HOME`完成登录并使用文件凭据，例如：

```bash
mkdir -p "$HOME/.codex-accounts/backup"
chmod 700 "$HOME/.codex-accounts/backup"
CODEX_HOME="$HOME/.codex-accounts/backup" codex -c 'cli_auth_credentials_store="file"' login
```

授权文件只在本机存储，限制目录及文件权限，不要发群、写日志或提交Git。注册表可动态读取，但不要在活跃任务期间替换某账号的授权源或把它改成另一个身份；应登记新名称后走切号命令。

## 命令

- `/account`：列出系统与自定义账号，标出已选与最近生效账号；授权文件可读不等于在线令牌有效或尚有额度。
- `/account backup`：选择当前群后续使用的账号，保留session与群工作目录。
- `/account system`：切回系统账号；即使自定义注册表损坏，这条回退入口仍可用。
- `/usage`：显示当前群最近生效账号的可信配额快照，待切号时同时标注待生效账号。
- `/usage all`、`/usage backup`：汇集已知Codex群中对应账号最新的可信快照，不主动发模型请求获取额度。

Codex不支持`/account auto`和`/usage delete`，不会触发Anthropic自动轮换或删除凭据。注册表只在本机增改，不另加飞书上传凭据入口。

## 生效时机

命令只保存群的`containerConfig.codexAccount`选择，不立即修改软链。正在运行时设置排空标志，后来的消息保留在宿主队列，不再送给旧runner。

旧runner只在轮次边界检查`_retire`，先处理此前已送入的消息，排空后退出。它与会中触发中断的`_close`分开；不调用killGroup、不发送中断、不清空session、不自动重放任务。

下一runner启动前固定账号选择、验证授权源，再原子替换群`auth.json`软链。授权源保持原地不动。已有独立实体auth文件不自动覆盖，报错提示本机备份处理；断链可在目标有效时重建。

群级`account-binding.json`记录最近生效名称、配置源、身份摘要及时间，不含token。受管群强制文件凭据存储，避免系统keyring选择其他账号。

## 配额归属

每群仍保留自己的rollout。切号时记录生效边界，仅使用边界之后的配额事件，并核对当前软链、配置文件与身份摘要；旧账号快照不会冒充新账号。

同账号多个群不相加百分比，而是取最新可信快照。无数据、缺时间戳或归属不明时显示未知；不把未知显示成零使用率。切回旧账号但尚无新快照时也可显示未知。

未迁移群只有软链确实指向系统授权源时才复用历史快照；自定义注册表损坏不会影响系统账号的默认启动。生效记录损坏则停止受管启动，需要本机核对，不静默猜号。

## 平滑迁移

先发布兼容代码；旧群无新配置时不改auth链接或生成迁移记录。需要重启宿主时单独安排窗口，不声称发布过程零中断。

独立登录新账号，登记文件，只选一个空闲群验证；再逐群切换。回退用`/account system`，在相同排空边界生效。不得在额度错误后悄悄重放上一任务。

## 明确边界

- 保留既有多群并行；没有实现跨进程OAuth刷新协调。文件共享的刷新竞争是原有风险，不能说双账号消除了它。
- 已有0.153.4源码与隔离假key实验确认文件写回穿透软链；未用生产refresh_token做实验。
- 本地测试用隔离文件和假Codex协议进程验证绑定、启动、账号切换及thread参数传递；不等于真实OpenAI账号之间续聊已通过。
- 真实第二账号登录、跨账号历史恢复、服务端并发刷新、真实飞书命令发布验收仍须隔离测试账号和受控发布窗口。

## 测试接口

账号注册/绑定使用真实临时文件；命令通过公开handler与dispatch验证；队列验证旧消息排空与新消息留队；两个runner通过隔离子进程协议验证身份文件与resume参数。配额测试把A的高使用率旧事件与B的新事件放在同一rollout，检查不会混读。
