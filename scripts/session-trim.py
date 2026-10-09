#!/usr/bin/env python3
"""
会话文件巡检截尾 —— 防止 Claude 会话 jsonl 超过 Node 单字符串上限（~512MB）导致 resume 秒崩。

截法：从「最后一个 compact_boundary」处切。边界之前的内容压缩后模型本来就看不到，
删掉不损失任何上下文；压缩摘要紧跟在边界后面，会完整保留。
（09-25 / 10-01 两次按字节截尾把摘要一起截掉了，这是本脚本要避免的。）

安全约束：
  - 只处理 sessions 表里的活跃会话；
  - 该群有 runner 在跑就跳过（防止截断正在追加的文件）；
  - 原地写回保 inode；写之前完整备份；
  - 找不到压缩边界 / 边界后仍超安全线 → 不截，记为需人工处理（不做兜底按字节截）。

用法：
  session-trim.py            真正执行
  session-trim.py --dry-run  只报告不改
输出：stdout 打印人类可读报告；同时写 data/session-trim/last.json 供定时任务读取。
"""
import json, os, sqlite3, subprocess, sys, shutil, datetime, glob

ROOT = "/Users/dajay/AI_Workspace/nanoclaw"
BACKUP_DIR = "/Users/dajay/AI_Workspace/backups/session-shrink"
REPORT = f"{ROOT}/data/session-trim/last.json"
TRIGGER = 300 * 1024**2      # 超过即截
DANGER = 450 * 1024**2       # 截后仍超此值视为截不动
DRY = "--dry-run" in sys.argv
MB = lambda n: f"{n/1024**2:.0f}MB"


def runner_alive(folder: str) -> bool:
    r = subprocess.run(["pgrep", "-f", f'NANOCLAW_GROUP_FOLDER":"{folder}"'], capture_output=True)
    return r.returncode == 0


def alias_of(folder: str, db) -> str:
    if folder == "Gemini3_1":
        return "7号"
    jid = "fs:" + folder[3:] if folder.startswith("fs_") else folder
    row = db.execute("SELECT alias FROM group_aliases WHERE chat_jid=? AND alias LIKE '%号' LIMIT 1", (jid,)).fetchone()
    return row[0] if row else folder


def trim_one(path: str):
    """返回 (新内容bytes, 说明)；无法安全截则抛 RuntimeError"""
    lines = [l for l in open(path, "rb").read().split(b"\n") if l]
    bnd = None
    for i in range(len(lines) - 1, -1, -1):
        # 先粗筛再解析，不依赖 JSON 序列化的空格格式
        if b"compact_boundary" in lines[i]:
            try:
                if json.loads(lines[i]).get("subtype") == "compact_boundary":
                    bnd = i
                    break
            except ValueError:
                pass
    if bnd is None:
        raise RuntimeError("没有压缩边界，无法无损截")
    if bnd == 0:
        raise RuntimeError("已从边界开始，无可截内容（单次压缩后内容本身过大）")
    kept = lines[bnd:]
    data = b"\n".join(kept) + b"\n"
    if len(data) > DANGER:
        raise RuntimeError(f"边界后仍有 {MB(len(data))}，超安全线")
    # 自检：首行是边界、摘要在前 10 行、全部是合法 JSON
    assert json.loads(kept[0]).get("subtype") == "compact_boundary"
    if not any(json.loads(x).get("isCompactSummary") for x in kept[:10]):
        raise RuntimeError("边界后未找到压缩摘要，结构异常")
    for x in kept:
        json.loads(x)
    return data, f"{len(lines)}→{len(kept)} 行"


def main():
    db = sqlite3.connect(f"{ROOT}/store/messages.db")
    rows = db.execute("SELECT group_folder, session_id FROM sessions").fetchall()
    today = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    trimmed, skipped, errors, near = [], [], [], []

    for folder, sid in rows:
        hits = glob.glob(f"{ROOT}/data/sessions/{folder}/.claude/projects/*/{sid}.jsonl")
        if not hits:
            continue
        path = hits[0]
        size = os.path.getsize(path)
        name = alias_of(folder, db)
        if size < TRIGGER:
            if size > 200 * 1024**2:
                near.append(f"{name} {MB(size)}")
            continue
        if runner_alive(folder):
            skipped.append(f"{name} {MB(size)}（runner 在跑，明天再试）")
            continue
        try:
            data, note = trim_one(path)
        except Exception as e:
            errors.append(f"{name} {MB(size)}：{e}")
            continue
        if DRY:
            trimmed.append(f"{name} {MB(size)}→{MB(len(data))}（{note}）[演练未执行]")
            continue
        # 写前再确认一次 runner 不在
        if runner_alive(folder):
            skipped.append(f"{name} {MB(size)}（执行前 runner 起来了，跳过）")
            continue
        os.makedirs(BACKUP_DIR, exist_ok=True)
        bak = f"{BACKUP_DIR}/{folder}-{sid[:8]}.bak-full-{today}.jsonl"
        shutil.copyfile(path, bak)
        with open(path, "r+b") as f:  # 原地写回，保 inode
            f.write(data)
            f.truncate()
        trimmed.append(f"{name} {MB(size)}→{MB(len(data))}（{note}）备份 {os.path.basename(bak)}")

    report = {"time": datetime.datetime.now().isoformat(timespec="seconds"), "dry_run": DRY,
              "trimmed": trimmed, "skipped": skipped, "errors": errors, "near": near}
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    if not DRY:
        json.dump(report, open(REPORT, "w"), ensure_ascii=False, indent=2)
    for k, title in (("trimmed", "已截"), ("skipped", "跳过"), ("errors", "需人工"), ("near", "接近阈值(>200MB)")):
        print(f"{title}: " + ("；".join(report[k]) if report[k] else "无"))


if __name__ == "__main__":
    main()
