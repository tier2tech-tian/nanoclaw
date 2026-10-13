#!/bin/bash
# 从开发副本同步到 skill（脚本/状态机真值在 fen95-flows/tools，配方真值在飞书表）。改完跑一次，然后改 VERSION + CHANGELOG。
set -e
S="$(cd "$(dirname "$0")" && pwd)"; F=/Users/dajay/AI_Workspace/fen95-flows/tools
cp "$F"/statemachine/{build_sm.py,fen95_state_machine.json,smq.py,README.md} "$S/statemachine/"
cp "$F"/datafactory/{df.py,t1q.py,README.md} "$S/datafactory/"; cp "$F"/datafactory/recipes/*.py "$S/datafactory/recipes/"
python3 "$S/recipes/export_recipes.py"
echo "synced $(date '+%F %T')  version $(cat "$S/VERSION")"
