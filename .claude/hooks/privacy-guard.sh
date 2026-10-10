#!/bin/bash
# PreToolUse hook: before Claude runs `git commit` or `git push`, scan what
# would be published and block it if personal or client details slipped in.
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
case "$cmd" in
  *"git commit"*) flags="--diff --cached" ;;
  *"git push"*)   flags="--diff" ;;
  *) exit 0 ;;
esac
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# shellcheck disable=SC2086
python3 work-tools/privacy_check.py $flags 1>&2 || exit 2
