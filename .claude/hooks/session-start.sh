#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: makes `npm test` runnable.
#
# This 2015 codebase targets Node 0.12 and has no lockfile, so a plain
# `npm install` on modern Node fails (dead git dependency, native modules)
# and pulls in newer releases that break lint and tests. Instead we:
#   1. install Node 0.12 and put it first on PATH for the session;
#   2. install, with modern npm, only the packages needed by lint/test/standalone,
#      pinned to what the registry served in mid-2015 (--before).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

NODE_VERSION=v0.12.18
NODE_DIR="$HOME/.local/node-$NODE_VERSION"
REGISTRY_DATE=2015-08-01

# 1. Node 0.12 (used to run lint and tests; modern npm still does the install).
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$NODE_DIR"
  curl -sSfL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" \
    | tar xz -C "$NODE_DIR" --strip-components=1
fi
echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
# test/cli.watcher.js cannot kill its child process in containers and hangs
# `npm test`; it skips itself on CI (TRAVIS/APPVEYOR), so run tests the same way.
echo "export TRAVIS=true" >> "$CLAUDE_ENV_FILE"

# 2. Dependencies. Skip if already installed (container state is cached).
if [ -f node_modules/.claude-session-deps ]; then
  exit 0
fi

# Install from a trimmed copy of package.json: all runtime deps, plus only the
# dev deps lint/test/standalone use (docs deps include unreachable git URLs).
backup=$(mktemp)
cp package.json "$backup"
trap 'cp "$backup" package.json; rm -f "$backup"' EXIT

node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
const keep = ["tape", "eslint", "babel-eslint", "babel-core", "eslint-plugin-react", "browserify"];
p.devDependencies = Object.fromEntries(keep.map((k) => [k, p.devDependencies[k]]));
// 1.2.x (June 2015) changed :not() output; fixtures expect the earlier behavior.
p.dependencies["postcss-selector-not"] = "1.0.1";
// left-pad was republished in 2016, so --before cannot see it.
p.overrides = { "left-pad": "https://registry.npmjs.org/left-pad/-/left-pad-0.0.3.tgz" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'

# --ignore-scripts avoids native builds that fail on modern toolchains;
# caniuse-api needs its build step, so run that one explicitly.
npm install --no-audit --no-fund --no-package-lock --ignore-scripts --before="$REGISTRY_DATE"
npm rebuild caniuse-api

touch node_modules/.claude-session-deps
