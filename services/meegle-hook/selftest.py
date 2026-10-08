"""本地自测：发一条正确签名和一条错误签名的假事件，检查落盘与验签结果，最后清理。"""
import hashlib
import json
import os
import sys
import time
import urllib.request

DATA_DIR = os.path.expanduser(os.environ.get("MEEGLE_HOOK_DATA", "~/ai/meegle-hook-data"))
url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18775/hook"
tok = open(os.path.join(DATA_DIR, ".callback_token")).read().strip()
rt = str(int(time.time() * 1000))
good = hashlib.sha256(f"MII_6ABA18B45C808CB7{rt}{tok}".encode()).hexdigest()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for sig in (good, "bad"):
    body = json.dumps({"request_time": rt, "signature": sig,
                       "data": {"event_type": 9999, "idempotent_key": "selftest" + sig[:6]}}).encode()
    t0 = time.time()
    r = opener.open(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}))
    print(r.status, r.read().decode(), f"{(time.time() - t0) * 1000:.0f}ms")
time.sleep(0.5)
ev = os.path.join(DATA_DIR, "events")
for name in sorted(os.listdir(ev)):
    if "_9999_" in name:
        print(name, "signature_ok =", json.load(open(os.path.join(ev, name)))["signature_ok"])
        os.remove(os.path.join(ev, name))
