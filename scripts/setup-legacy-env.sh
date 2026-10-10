#!/bin/bash
# Prepares an environment where `npm test` runs: used by the Claude Code
# SessionStart hook and by GitHub Actions.
#
# This 2015 codebase targets Node 0.12 and has no lockfile, so a plain
# `npm install` on modern Node fails (dead git dependency, native modules)
# and pulls in newer releases that break lint and tests. Instead we:
#   1. install Node 0.12 into $NODE_DIR (callers put $NODE_DIR/bin on PATH);
#   2. install, with the modern npm already on PATH, only the packages needed
#      by lint/test/standalone, pinned to what the registry served in mid-2015.
#
# Prints the Node 0.12 bin directory on its last line of stdout.
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_VERSION=v0.12.18
NODE_DIR="${NODE_DIR:-$HOME/.local/node-$NODE_VERSION}"
REGISTRY_DATE=2015-08-01

# 1. Node 0.12 (used to run lint and tests; modern npm still does the install).
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$NODE_DIR"
  curl -sSfL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" \
    | tar xz -C "$NODE_DIR" --strip-components=1
fi

# 2. Dependencies. Skip if already installed (cached container state).
if [ ! -f node_modules/.legacy-env-deps ]; then
  # Install from a trimmed copy of package.json: all runtime deps, plus only the
  # dev deps lint/test/standalone use (docs deps include unreachable git URLs).
  backup=$(mktemp)
  cp package.json "$backup"
  trap 'cp "$backup" package.json; rm -f "$backup"' EXIT

  node -e '
  var fs = require("fs");
  var p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  var keep = ["tape", "eslint", "babel-eslint", "babel-core", "eslint-plugin-react", "browserify"];
  var devDependencies = {};
  keep.forEach(function(k) { devDependencies[k] = p.devDependencies[k]; });
  p.devDependencies = devDependencies;
  // 1.2.x (June 2015) changed :not() output; fixtures expect the earlier behavior.
  p.dependencies["postcss-selector-not"] = "1.0.1";
  // left-pad was republished in 2016, so --before cannot see it.
  p.overrides = { "left-pad": "https://registry.npmjs.org/left-pad/-/left-pad-0.0.3.tgz" };
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
  '

  # --ignore-scripts avoids native builds that fail on modern toolchains;
  # caniuse-api needs its build step, so run that one explicitly.
  npm install --no-audit --no-fund --no-package-lock --ignore-scripts --before="$REGISTRY_DATE" >&2
  npm rebuild caniuse-api >&2

  touch node_modules/.legacy-env-deps
fi

echo "$NODE_DIR/bin"
