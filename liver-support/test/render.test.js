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

test("折り返しは行を均等に配り、最終行だけが余る形にしない", () => {
  // 実際に描画して見つかった問題: 貪欲に詰めると「…見せ / ます」と2文字だけ残る
  assert.deepStrictEqual(wrapJa("読み間違いを30秒で見せます", 12), [
    "読み間違いを",
    "30秒で見せます",
  ])
  assert.deepStrictEqual(wrapJa("あいうえお", 12), ["あいうえお"])
})

test("数字と単位の間で切らない", () => {
  for (const line of wrapJa("残り1秒の逆転を30秒で見せます", 12)) {
    assert.ok(!/^[%位倍人回本個円分秒時日週月年名点件]/.test(line), `単位が行頭に来た: ${line}`)
    assert.ok(!/[0-9]$/.test(line), `数字で行が終わった: ${line}`)
  }
})

test("句読点と小書き仮名を行頭に置かない", () => {
  const samples = [
    "コメント、盛大に読み間違えた",
    "雑談配信、はじめて3ヶ月の現在地",
    "この対応、正解だったと思う？",
  ]
  for (const text of samples) {
    const lines = wrapJa(text, 8)
    for (const line of lines.slice(1)) {
      assert.ok(!"、。！？」ゃゅょっー".includes(line[0]), `行頭に置けない文字: ${line}`)
    }
  }
})

test("どの行も上限文字数を超えない", () => {
  const long = "配信中に起きたことをそのまま全部見せます、これが現場です"
  for (const max of [8, 12, 16]) {
    for (const line of wrapJa(long, max)) {
      assert.ok(line.length <= max + 1, `${max}文字の上限を超えた: ${line}（${line.length}）`)
    }
  }
})

test("折り返しても文字が落ちない", () => {
  const text = "残り1秒の逆転を30秒で見せます"
  assert.strictEqual(wrapJa(text, 12).join(""), text)
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

test("テロップも折り返して書き出す（画面外にはみ出さない）", () => {
  const { post } = samplePost()
  post.telop = "配信中に起きたことをそのまま全部お見せします"
  post.telopLines = wrapJa(post.telop, 12)
  const cmd = renderCommand(post)
  writeTextFiles(cmd)
  const written = fs.readFileSync(cmd.textFiles[1].path, "utf8").trim()
  assert.ok(written.includes("\n"), "テロップが1行のまま書き出されている")
  for (const line of written.split("\n")) assert.ok(line.length <= 13)
  assert.strictEqual(written.replace(/\n/g, ""), post.telop)
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
