"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { test } = require("node:test")

const { loadConfig } = require("../lib/config")
const { buildPlan } = require("../lib/plan")
const { renderCommand, toShell, writeTextFiles } = require("../lib/render")
const { wrapJa } = require("../lib/util")
const { buildCaption } = require("../lib/caption")
const { toQueue, due } = require("../lib/queue")
const { describe: describePublish } = require("../lib/publish")
const { makeWorkspace } = require("../test-utils/fixtures")

function samplePost() {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const plan = buildPlan(config, { days: 1, startDate: "2026-09-01", outDir: path.join(ws.dir, "build") })
  return { ws, plan, post: plan.posts[0] }
}

test("テロップは日本語を文字数で折り返す（句読点は行頭に置かない）", () => {
  assert.deepStrictEqual(wrapJa("この設定、知らないと損してます", 10), [
    "この設定、知らないと",
    "損してます",
  ])
  assert.deepStrictEqual(wrapJa("あいうえお", 12), ["あいうえお"])
})

test("ffmpeg コマンドはフックと本編を concat し、9:16 に整える", () => {
  const { post } = samplePost()
  const cmd = renderCommand(post)
  const filter = cmd.args[cmd.args.indexOf("-filter_complex") + 1]
  assert.ok(filter.includes("concat=n=2:v=1:a=1[outv][outa]"))
  assert.ok(filter.includes("scale=1080:1920:force_original_aspect_ratio=decrease"))
  assert.ok(filter.includes("pad=1080:1920"))
  assert.ok(cmd.args.includes("libx264"))
  assert.ok(cmd.output.endsWith(".mp4"))
})

test("フィルタ内で同じ入力ラベルを2度使わない（音声なし素材でも成立する）", () => {
  const { post } = samplePost()
  const filter = (p) => {
    const cmd = renderCommand(p)
    return cmd.args[cmd.args.indexOf("-filter_complex") + 1]
  }
  const withAudio = filter(post)
  assert.strictEqual((withAudio.match(/\[1:a\]/g) || []).length, 1)

  const silent = filter(Object.assign({}, post, { clipHasAudio: false }))
  assert.ok(silent.includes("asplit=2"))
  assert.strictEqual((silent.match(/\[1:a\]/g) || []).length, 1)
  assert.strictEqual((silent.match(/\[2:a\]/g) || []).length, 0)
})

test("テキストは filter に直書きせず textfile= で渡す", () => {
  const { post } = samplePost()
  const cmd = renderCommand(post)
  const filter = cmd.args[cmd.args.indexOf("-filter_complex") + 1]
  assert.ok(filter.includes("textfile="))
  assert.ok(!filter.includes(post.hookText))
  writeTextFiles(cmd)
  assert.strictEqual(fs.readFileSync(cmd.textFiles[0].path, "utf8").trim(), post.hookLines.join("\n"))
})

test("シェル出力はスペースや記号を含む引数をクォートする", () => {
  const { post } = samplePost()
  const line = toShell(renderCommand(post))
  assert.ok(line.startsWith("ffmpeg "))
  assert.ok(line.includes("'") || !/ -filter_complex [^']*\[/.test(line))
})

test("キャプションはハッシュタグ上限を守り、重複を除く", () => {
  const liver = { name: "ひな", hashtags: ["#ライバー", "#雑談配信", "#ライバー"], cta: "21時から配信" }
  const clip = { tags: ["雑談配信", "切り抜き", "神対応", "ハプニング"] }
  const cap = buildCaption(liver, clip, { text: "フック文" }, { maxHashtags: 3 })
  assert.strictEqual(cap.hashtags.length, 3)
  assert.strictEqual(new Set(cap.hashtags).size, 3)
  assert.ok(cap.text.includes("21時から配信"))
})

test("キューは予約時刻を過ぎた pending だけを返す", () => {
  const { plan } = samplePost()
  const entries = toQueue(plan)
  assert.strictEqual(entries[0].status, "pending")
  assert.strictEqual(due(entries, "2026-09-01T10:00:00+09:00").length, 0)
  assert.strictEqual(due(entries, "2026-09-01T20:00:00+09:00").length, 1)
})

test("publish の dry-run はトークン値を出さず、既定は下書き(inbox)", () => {
  const { plan, ws } = samplePost()
  const entry = toQueue(plan)[0]
  entry.video = path.join(ws.dir, "dummy.mp4")
  fs.writeFileSync(entry.video, Buffer.alloc(1024))
  process.env[entry.tokenEnv] = "secret-token-value"
  const plan1 = describePublish(entry, "inbox")
  assert.ok(plan1.steps[0].includes("/post/publish/inbox/video/init/"))
  assert.strictEqual(plan1.tokenPresent, true)
  assert.ok(!JSON.stringify(plan1).includes("secret-token-value"))
  assert.strictEqual(plan1.body.post_info, undefined)

  const plan2 = describePublish(entry, "direct")
  assert.ok(plan2.steps[0].includes("/post/publish/video/init/"))
  assert.strictEqual(plan2.body.post_info.privacy_level, "SELF_ONLY")
  delete process.env[entry.tokenEnv]
})

test("一時ディレクトリを汚さない（fixtures は os.tmpdir 配下）", () => {
  const { ws } = samplePost()
  assert.ok(ws.dir.startsWith(os.tmpdir()))
})
