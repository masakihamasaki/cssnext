#!/usr/bin/env node
"use strict"

/**
 * 実素材が無くても一連の流れ（plan → build → queue → publish --dry-run）を試せるように、
 * ダミー素材付きのデモ用ワークスペースを作る。
 *
 *   node liver-support/test-utils/make-demo.js [出力先]
 */

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const out = path.resolve(process.argv[2] || path.join(root, "build/demo"))
const example = JSON.parse(fs.readFileSync(path.join(root, "config/livers.example.json"), "utf8"))

fs.mkdirSync(out, { recursive: true })
for (const liver of example.livers) {
  for (const clip of liver.clips) {
    // 生成待ちの AI 素材はファイルを作らない（lsw prompts の対象として残す）
    if (clip.pending === true || !clip.file) continue
    const file = path.join(out, path.basename(path.dirname(clip.file)), path.basename(clip.file))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (!fs.existsSync(file)) fs.writeFileSync(file, "dummy mp4 (デモ用の空ファイル)")
    clip.file = path.relative(out, file)
  }
}
example.hooksFile = path.join(root, "config/hooks.ja.json")
example.defaults.video.fontFile = ""
fs.writeFileSync(path.join(out, "livers.json"), JSON.stringify(example, null, 2) + "\n")

console.log(`デモ設定を作成: ${path.join(out, "livers.json")}`)
console.log(`  node ${path.relative(process.cwd(), path.join(root, "bin/lsw.js"))} plan --config ${path.relative(process.cwd(), path.join(out, "livers.json"))} --start 2026-09-01 --days 5`)
