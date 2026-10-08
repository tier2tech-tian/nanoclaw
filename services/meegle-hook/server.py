"""飞书项目 AI 节点回调接收服务。

- 收到推送立即回 200（平台要求 1000ms 内，否则重发 4 次）
- 按 sha256(plugin_id + request_time + 回调token) 验签；验签失败只落盘不占幂等键
- 按 data.idempotent_key 完整键原子去重（seen/ 下 O_EXCL 建文件），每个事件落一个 JSON 到 events/
- 派活：AI 节点进入 running（8001 after=running）→ 按 employee.json 的 nodes 找员工，
  POST NanoClaw /meegle/dispatch（员工 × 需求 = 一个会话）。只有成功才算派过；失败退避重试，
  启动时及每 10 分钟补派近 24 小时没成功的（NanoClaw 按 flow_id 幂等，重派不会入队两次）。
  重试/补派前先查节点当前状态：仍是这一批次且在 running 才派，已被新批次取代/终止的标作废，查询失败留待下次
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
SEEN_DIR = os.path.join(DATA_DIR, "seen")
RETRY_DELAYS = (0, 10, 60, 300)
RECOVER_WINDOW_S = 24 * 3600
RECOVER_EVERY_S = 600
PLUGIN_ID = os.environ.get("MEEGLE_AI_PLUGIN_ID", "MII_6ABA18B45C808CB7")
PORT = int(os.environ.get("MEEGLE_HOOK_PORT", "18775"))
with open(os.path.join(DATA_DIR, ".callback_token")) as f:
    CALLBACK_TOKEN = f.read().strip()


NODE_NAMES = {"ai_review": "AI 需求评审", "pre_dev": "预开发", "dev": "开发", "test_exec": "测试执行"}
NANOCLAW_DISPATCH = os.environ.get("NANOCLAW_DISPATCH_URL", "http://127.0.0.1:19877/meegle/dispatch")
DISPATCHED = os.path.join(DATA_DIR, "dispatched.jsonl")
_lock = threading.Lock()
_inflight: set = set()


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
    """已了结：派成功或已作废（节点不再是这一批次在跑）；单纯失败不挡重试"""
    if not os.path.exists(DISPATCHED):
        return False
    with open(DISPATCHED) as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            if rec.get("flow_id") == flow_id and (rec.get("ok") or rec.get("stale")):
                return True
    return False


def node_current(emp_dir: str, wid, node: str):
    """查 AI 节点当前 (status, current_flow_id)；查询失败返回 None"""
    for rel in ("bin/meegle-emp", "lib/meegle-emp"):
        tool = os.path.join(emp_dir, rel)
        if not os.path.exists(tool):
            continue
        try:
            r = subprocess.run([tool, "query", str(wid), node], capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                return None
            ai = (json.loads(r.stdout) or {}).get("ai_info") or {}
        except (subprocess.SubprocessError, ValueError):
            return None
        return ai.get("status"), ai.get("current_flow_id")
    return None


def _post_dispatch(payload: bytes):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        r = opener.open(urllib.request.Request(NANOCLAW_DISPATCH, data=payload, method="POST",
                                               headers={"Content-Type": "application/json"}), timeout=60)
        return r.status == 200, r.read().decode()
    except Exception as e:  # noqa: BLE001
        return False, repr(e)


def _record(entry: dict):
    with _lock, open(DISPATCHED, "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), **entry}, ensure_ascii=False) + "\n")


def dispatch(data: dict, check_first: bool = False):
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
    # 锁只管查重和占位，重试等待不占锁（别的需求照常派）
    with _lock:
        if flow_id and (flow_id in _inflight or _already_dispatched(flow_id)):
            _log(f"skip dispatch: flow {flow_id} 已派过或正在派")
            return
        _inflight.add(flow_id)
    try:
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
        base = {"flow_id": flow_id, "node": node, "work_item_id": wid, "employee": employee_id}
        for attempt, delay in enumerate(RETRY_DELAYS, 1):
            time.sleep(delay)
            # 首派紧跟回调，节点必然在跑；重试/补派可能隔了很久，先核对还是不是这一批次
            if attempt > 1 or check_first:
                cur = node_current(emp_dir, wid, node)
                if cur is None:
                    _record({**base, "ok": False, "attempt": attempt, "result": "节点状态查询失败，留待下次"})
                    continue
                if cur != ("running", flow_id):
                    _record({**base, "ok": False, "stale": True, "attempt": attempt,
                             "result": f"节点已不是本批次在跑：status={cur[0]} flow={cur[1]}"})
                    _log(f"dispatch 作废 flow={flow_id}：当前 {cur}")
                    return
            ok, result = _post_dispatch(payload)
            _record({**base, "ok": ok, "attempt": attempt, "result": result[:300]})
            _log(f"dispatch employee={employee_id} node={node} wid={wid} flow={flow_id} ok={ok} attempt={attempt}")
            if ok:
                return
        _log(f"dispatch 重试 {len(RETRY_DELAYS)} 次仍失败，等定时补派: flow={flow_id}")
    finally:
        with _lock:
            _inflight.discard(flow_id)


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
    try:
        r = subprocess.run([tool, "restart", str(wid), node], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        _log(f"restart 超时 node={node} wid={wid}")
        return
    if r.returncode != 0:
        _log(f"restart 失败 node={node} wid={wid} code={r.returncode}: {(r.stderr or r.stdout).strip()[:300]}")
        return
    _log(f"restart node={node} wid={wid}: {r.stdout.strip()[:200]}")


def handle(data: dict):
    et = data.get("event_type")
    after = ((data.get("change_ai_node_info") or {}).get("after") or {}).get("status")
    if et == 8001 and after == "running":
        dispatch(data)
    elif et == 8004:
        restart_if_stuck(data)


def recover():
    """启动补派：近 24 小时验签通过、AI 节点进入 running、但没派成功的事件"""
    cutoff = time.time() - RECOVER_WINDOW_S
    for name in sorted(os.listdir(EVENTS_DIR)):
        path = os.path.join(EVENTS_DIR, name)
        if not name.endswith(".json") or os.path.getmtime(path) < cutoff:
            continue
        try:
            with open(path) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            continue
        data = (rec.get("body") or {}).get("data") or {}
        after = ((data.get("change_ai_node_info") or {}).get("after") or {}).get("status")
        if not rec.get("signature_ok") or data.get("event_type") != 8001 or after != "running":
            continue
        if data.get("ai_flow_id") and not _already_dispatched(data["ai_flow_id"]):
            _log(f"补派 {name}")
            dispatch(data, check_first=True)


def recover_loop():
    while True:
        try:
            recover()
        except Exception as e:  # noqa: BLE001
            _log(f"补派异常: {e!r}")
        time.sleep(RECOVER_EVERY_S)


def claim(key: str) -> bool:
    """按完整幂等键原子占位：第一次返回 True，重复返回 False"""
    path = os.path.join(SEEN_DIR, hashlib.sha256(key.encode()).hexdigest())
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return True
    except FileExistsError:
        return False


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
        signature_ok = verify(body)
        # 先验签再占幂等键：伪造/坏签名的请求不能挡掉同键的合法事件
        if signature_ok and not claim(key):
            return  # 重发的重复事件
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        path = os.path.join(EVENTS_DIR, f"{int(time.time() * 1000)}_{data.get('event_type', 'x')}_{digest}.json")
        record = {
            "received_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "path": self.path,
            "signature_ok": signature_ok,
            "body": body,
        }
        with open(path, "w") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        if signature_ok:
            threading.Thread(target=handle, args=(data,), daemon=True).start()
        else:
            _log(f"验签失败，不处理: {os.path.basename(path)}")

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    os.makedirs(EVENTS_DIR, exist_ok=True)
    os.makedirs(SEEN_DIR, exist_ok=True)
    threading.Thread(target=recover_loop, daemon=True).start()
    print(f"meegle-hook listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
