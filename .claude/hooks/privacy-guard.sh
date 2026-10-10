#!/bin/bash
# PreToolUse hook: before Claude runs `git commit` or `git push`, scan what
# would be published and block it if personal or client details slipped in.
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
# Only real git invocations at the start of a command segment, not the words
# appearing inside a string or comment.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|&&|\|\|)[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+push'; then
  flags="--diff"
elif printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|&&|\|\|)[[:space:]]*git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+commit'; then
  flags="--diff --cached"
else
  exit 0
fi
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# shellcheck disable=SC2086
python3 work-tools/privacy_check.py $flags 1>&2 || exit 2
