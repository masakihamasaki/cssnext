#!/bin/bash
# Cloud sessions start from a fresh container: install what the content
# tools in work-tools/ need, so the skills can run them straight away.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
python3 -c "import pptx, docx" 2>/dev/null || pip install -q python-pptx python-docx >/dev/null 2>&1 || true
cat <<'MSG'
work-automation: 非公開の設定（読み辞書・執筆仕様・表記ルール・期限）は Google Drive の
「work-automation-private」フォルダにあります。スキルは最初にそこを読んでください。
リポジトリは公開設定です。個人名・取引先・金額・連絡先・非公開リンクは書き込まないこと。
MSG
