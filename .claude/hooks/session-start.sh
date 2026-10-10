#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: makes `npm test` runnable.
# See scripts/setup-legacy-env.sh for why the setup is unusual.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

node_bin=$("$CLAUDE_PROJECT_DIR/scripts/setup-legacy-env.sh" | tail -n 1)

echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
# test/cli.watcher.js cannot kill its child process in containers and hangs
# `npm test`; it skips itself on CI (TRAVIS/APPVEYOR), so run tests the same way.
echo "export TRAVIS=true" >> "$CLAUDE_ENV_FILE"
