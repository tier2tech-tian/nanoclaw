# meegle-hook

飞书项目 AI 节点回调接收服务。收到 8001（节点开始运行）后按 `EMPLOYEES_DIR/*/employee.json` 的 `nodes` 找员工，调 NanoClaw `POST /meegle/dispatch` 派活。

## 部署（细狗）

- 运行数据目录 `~/ai/meegle-hook-data`：`.callback_token`（36 位 UUID，与飞书项目 AI 节点 webhook 配置一致）、`events/`、`dispatched.jsonl`、日志。不进仓库。
- 服务：`launchd/com.nanoclaw.meegle-hook.plist`（python3 server.py，监听 127.0.0.1:18765）。
- 公网入口：Cloudflare Tunnel `meegle-hook`（`launchd/com.nanoclaw.meegle-tunnel.plist` + `cloudflared.yml`），只放行 `/` 和 `/hook`。
- 自测：`python3 selftest.py`（一条正确签名一条错误签名，检查落盘与验签）。
