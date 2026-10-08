"""飞书项目 AI 节点回调接收服务。

- 收到推送立即回 200（平台要求 1000ms 内，否则重发 4 次）
- 按 sha256(plugin_id + request_time + 回调token) 验签，结果写进落盘记录
- 按 data.idempotent_key 去重，每个事件落一个 JSON 到 events/
- 派活：AI 节点进入 running（8001 after=running）→ 按 employee.json 的 nodes 找员工，
  POST NanoClaw /meegle/dispatch（员工 × 需求 = 一个会话）
- 自愈：后续节点退回到 AI 节点（8004 且节点 REACHED、AI 状态停在 done）→ 员工 meegle-emp restart 置回 running，平台会重推 8001

运行数据（events/、dispatched.jsonl、.callback_token）放 MEEGLE_HOOK_DATA，不进仓库。
"""
import hashlib
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.path.expanduser(os.environ.get("MEEGLE_HOOK_DATA", "~/ai/meegle-hook-data"))
EMPLOYEES_DIR = os.path.expanduser(os.environ.get("EMPLOYEES_DIR", "~/ai/employees"))
EVENTS_DIR = os.path.join(DATA_DIR, "events")
PLUGIN_ID = os.environ.get("MEEGLE_AI_PLUGIN_ID", "MII_6ABA18B45C808CB7")
PORT = int(os.environ.get("MEEGLE_HOOK_PORT", "18775"))
with open(os.path.join(DATA_DIR, ".callback_token")) as f:
    CALLBACK_TOKEN = f.read().strip()


NODE_NAMES = {"ai_review": "AI 需求评审", "pre_dev": "预开发", "dev": "开发", "test_exec": "测试执行"}
NANOCLAW_DISPATCH = os.environ.get("NANOCLAW_DISPATCH_URL", "http://127.0.0.1:19877/meegle/dispatch")
DISPATCHED = os.path.join(DATA_DIR, "dispatched.jsonl")
_lock = threading.Lock()


def _log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def find_employee(project_key: str, state_key: str):
    """每次现扫 employee.json（加员工不用重启）；返回 (员工 id, 员工目录) 或 None"""
    if not os.path.isdir(EMPLOYEES_DIR):
        return None
    for name in sorted(os.listdir(EMPLOYEES_DIR)):
        path = os.path.join(EMPLOYEES_DIR, name, "employee.json")
        try:
            with open(path) as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            continue
        for n in manifest.get("nodes") or []:
            if n.get("project_key") == project_key and n.get("state_key") == state_key:
                return manifest.get("id"), os.path.join(EMPLOYEES_DIR, name)
    return None


def work_item_name(emp_dir: str, wid) -> str:
    """用员工自带的 meegle-emp 查需求名（给需求群起名用）；查不到返回空串，不影响派活"""
    for rel in ("bin/meegle-emp", "lib/meegle-emp"):
        tool = os.path.join(emp_dir, rel)
        if os.path.exists(tool):
            try:
                r = subprocess.run([tool, "get", str(wid)], capture_output=True, text=True, timeout=15)
                return (json.loads(r.stdout) or {}).get("name") or ""
            except (subprocess.SubprocessError, ValueError):
                return ""
    return ""


def _already_dispatched(flow_id: str) -> bool:
    if not os.path.exists(DISPATCHED):
        return False
    with open(DISPATCHED) as f:
        return any(json.loads(line).get("flow_id") == flow_id for line in f if line.strip())


def dispatch(data: dict):
    """AI 节点开始运行 → 派给负责该节点的员工。按 ai_flow_id 去重（一次运行只派一次）。"""
    node = (data.get("ai_node_info") or {}).get("state_key", "")
    project = data.get("project_key", "")
    wi = (data.get("work_item_info") or [{}])[0]
    wid = wi.get("work_item_id")
    flow_id = data.get("ai_flow_id", "")
    emp = find_employee(project, node)
    if not emp or not wid:
        _log(f"skip dispatch: project={project} node={node} wid={wid} 无员工")
        return
    employee_id, emp_dir = emp
    with _lock:
        if flow_id and _already_dispatched(flow_id):
            _log(f"skip dispatch: flow {flow_id} 已派过")
            return
        url = f"https://project.feishu.cn/{project}/story/detail/{wid}"
        text = (
            f"【飞书项目 AI 节点任务】{NODE_NAMES.get(node, node)}\n"
            f"- 工作项：{wid}（空间 {data.get('project_name', '')}）\n"
            f"- 链接：{url}\n"
            f"- 节点 state_key：{node}；本次运行 flow_id：{flow_id}\n"
            f"- 触发人：{(data.get('user_info') or {}).get('name_cn', '')}\n"
            f"按 CLAUDE.md 的 SOP 执行，完成后写回并流转节点。"
        )
        payload = json.dumps({"employee": employee_id, "work_item_id": str(wid), "state_key": node,
                              "work_item_name": work_item_name(emp_dir, wid),
                              "flow_id": flow_id, "text": text}).encode()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            r = opener.open(urllib.request.Request(NANOCLAW_DISPATCH, data=payload, method="POST",
                                                   headers={"Content-Type": "application/json"}), timeout=10)
            result = r.read().decode()
            ok = r.status == 200
        except Exception as e:  # noqa: BLE001
            ok, result = False, repr(e)
        with open(DISPATCHED, "a") as f:
            f.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "flow_id": flow_id, "node": node,
                                "work_item_id": wid, "employee": employee_id, "ok": ok, "result": result[:300]},
                               ensure_ascii=False) + "\n")
        _log(f"dispatch employee={employee_id} node={node} wid={wid} flow={flow_id} ok={ok}")


def restart_if_stuck(data: dict):
    """后续节点退回到 AI 节点：平台只推 8004，AI 状态停在 done 不会重跑 → 置回 running。"""
    ai = data.get("ai_node_info") or {}
    status = (ai.get("ai_info") or {}).get("status")
    node = ai.get("state_key", "")
    wid = ((data.get("work_item_info") or [{}])[0]).get("work_item_id")
    emp = find_employee(data.get("project_key", ""), node)
    if ai.get("node_state") != "REACHED" or status != "done" or not emp or not wid:
        return
    tool = os.path.join(emp[1], "bin", "meegle-emp")
    r = subprocess.run([tool, "restart", str(wid), node], capture_output=True, text=True)
    _log(f"restart node={node} wid={wid}: {r.stdout.strip()[:200]}")


def handle(data: dict):
    et = data.get("event_type")
    after = ((data.get("change_ai_node_info") or {}).get("after") or {}).get("status")
    if et == 8001 and after == "running":
        dispatch(data)
    elif et == 8004:
        restart_if_stuck(data)


def verify(body: dict) -> bool:
    raw = f"{PLUGIN_ID}{body.get('request_time', '')}{CALLBACK_TOKEN}".encode()
    return hashlib.sha256(raw).hexdigest() == body.get("signature")


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # 健康检查
        self._reply(200, {"ok": True, "service": "meegle-hook"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._reply(400, {"ok": False, "error": "bad json"})
            return
        # 先回 200，落盘在后
        self._reply(200, {"ok": True})
        data = body.get("data") or {}
        key = data.get("idempotent_key") or f"nokey-{time.time_ns()}"
        path = os.path.join(EVENTS_DIR, f"{int(time.time() * 1000)}_{data.get('event_type', 'x')}_{key[:16]}.json")
        if any(name.endswith(f"_{key[:16]}.json") for name in os.listdir(EVENTS_DIR)):
            return  # 重发的重复事件
        record = {
            "received_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "path": self.path,
            "signature_ok": verify(body),
            "body": body,
        }
        with open(path, "w") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        if record["signature_ok"]:
            threading.Thread(target=handle, args=(data,), daemon=True).start()
        else:
            _log(f"验签失败，不处理: {os.path.basename(path)}")

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    os.makedirs(EVENTS_DIR, exist_ok=True)
    print(f"meegle-hook listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
