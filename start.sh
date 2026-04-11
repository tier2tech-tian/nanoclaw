#!/bin/bash
# NanoClaw 启动脚本 — 启动前自动修复 better-sqlite3 native binding

NODE="/Users/dajay/.nvm/versions/node/v22.22.0/bin/node"
DIR="/Users/dajay/AI_Workspace/nanoclaw"
BINDING="$DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
BACKUP="$DIR/data/better_sqlite3.node.bak"

if [ ! -f "$BINDING" ]; then
  echo "[start.sh] better_sqlite3.node missing, restoring from backup..."
  mkdir -p "$(dirname "$BINDING")"
  cp "$BACKUP" "$BINDING"
  chmod +x "$BINDING"
  echo "[start.sh] restored."
fi

exec "$NODE" "$DIR/dist/index.js"
