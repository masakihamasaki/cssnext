"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { test } = require("node:test")

const { loadConfig } = require("../lib/config")
const { buildPlan } = require("../lib/plan")
const { buildCaption } = require("../lib/caption")
const { toQueue } = require("../lib/queue")
const { publish, describe: describePublish, initBody, aiGuard } = require("../lib/publish")
const { buildPrompt, promptSheet, toMarkdown } = require("../lib/aiprompts")
const { makeWorkspace } = require("../test-utils/fixtures")

const AI_PROMPTS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../config/ai-prompts.ja.json"), "utf8")
)

/** AI素材を1本足した設定を作る。overrides でその素材の項目を差し替える。 */
function withAiClip(overrides) {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  fs.writeFileSync(path.join(ws.dir, "assets", "ai1.mp4"), "dummy")
  raw.livers[0].clips.push(
    Object.assign(
      {
        id: "ai1",
        source: "ai",
        file: "assets/ai1.mp4",
        title: "グッズカット",
        topic: "新作グッズ",
        tags: ["グッズ"],
        prompt: "無地の背景に置かれたアクスタを手だけが回して見せる",
        model: "test-video-model",
        depictsLiver: false,
      },
      overrides || {}
    )
  )
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))
  return { ws, config: loadConfig(ws.configPath) }
}

test("AI素材は consent ではなく生成記録と肖像同意で判定する", () => {
  const { config } = withAiClip()
  const ai = config.livers[0].clips.find((c) => c.id === "ai1")
  assert.ok(ai, "本人が映らないAI素材は consent 無しでも使える")
  assert.strictEqual(ai.source, "ai")
})

test("生成プロンプトの記録が無いAI素材は使わない", () => {
  const { config } = withAiClip({ prompt: undefined })
  assert.strictEqual(config.livers[0].clips.some((c) => c.id === "ai1"), false)
  assert.ok(config.warnings.some((w) => w.includes("生成プロンプトの記録")))
})

test("本人の姿を生成したAI素材は肖像の明示同意が無いと使わない", () => {
  const blocked = withAiClip({ depictsLiver: true }).config
  assert.strictEqual(blocked.livers[0].clips.some((c) => c.id === "ai1"), false)
  assert.ok(blocked.warnings.some((w) => w.includes("肖像の明示同意")))

  const allowed = withAiClip({ depictsLiver: true, likenessConsent: true }).config
  assert.strictEqual(allowed.livers[0].clips.some((c) => c.id === "ai1"), true)
})

test("生成待ちの素材は計画に乗らず、プロンプト出力の対象になる", () => {
  const { config } = withAiClip({ id: "ai2", pending: true, file: undefined, templateId: "broll-desk" })
  assert.strictEqual(config.livers[0].clips.some((c) => c.id === "ai2"), false)
  assert.strictEqual(config.livers[0].pendingClips.length, 1)
  const sheets = promptSheet(config, AI_PROMPTS, {})
  assert.strictEqual(sheets.length, 1)
  assert.strictEqual(sheets[0].clipId, "ai2")
  assert.ok(sheets[0].variations[0].prompt.includes("9:16"))
})

test("AI素材を使う投稿のキャプションには開示が入る", () => {
  const { config } = withAiClip()
  const liver = config.livers[0]
  const clip = liver.clips.find((c) => c.id === "ai1")
  const cap = buildCaption(liver, clip, { text: "フック" }, {
    maxHashtags: 2,
    ai: config.defaults.ai,
  })
  assert.ok(cap.text.includes("AI生成"))
  assert.strictEqual(cap.containsAi, true)
  // 開示タグは上限に押し出されない
  assert.strictEqual(cap.hashtags[0], "#AI生成")
})

test("実写の切り抜きには開示を付けない", () => {
  const { config } = withAiClip()
  const liver = config.livers[0]
  const cap = buildCaption(liver, liver.clips[0], { text: "フック" }, { ai: config.defaults.ai })
  assert.strictEqual(cap.containsAi, false)
  assert.ok(!cap.text.includes("AI生成"))
})

test("計画とキューが AI素材を含む投稿に印を付ける", () => {
  const { config } = withAiClip()
  const plan = buildPlan(config, { days: 12, startDate: "2026-09-01" })
  const aiPost = plan.posts.find((p) => p.clipId === "ai1")
  assert.ok(aiPost)
  assert.strictEqual(aiPost.containsAi, true)
  assert.strictEqual(aiPost.clipSource, "ai")
  const entry = toQueue(plan).find((e) => e.id === aiPost.id)
  assert.strictEqual(entry.containsAi, true)
})

test("AI素材を含む投稿の直接公開は既定で止める", () => {
  const entry = { id: "x", containsAi: true, video: "/nonexistent.mp4", tokenEnv: "T", caption: "c" }
  assert.ok(aiGuard(entry, "direct", { forceInbox: true }))
  assert.strictEqual(aiGuard(entry, "inbox", { forceInbox: true }), null)
  assert.strictEqual(aiGuard(entry, "direct", { forceInbox: false }), null)
  assert.strictEqual(aiGuard({ id: "y" }, "direct", { forceInbox: true }), null)

  const shown = describePublish(entry, "direct", { forceInbox: true })
  assert.ok(shown.blocked)
  assert.strictEqual(shown.containsAi, true)
})

test("--execute でも AI素材の直接公開は拒否する", async () => {
  const entry = { id: "x", containsAi: true, video: "/nonexistent.mp4", tokenEnv: "T", caption: "c" }
  const res = await publish(entry, { execute: true, mode: "direct", ai: { forceInbox: true } })
  assert.strictEqual(res.ok, false)
  assert.match(res.error, /直接公開は既定で禁止/)
})

test("AIGCフラグは設定を入れたときだけ送る", () => {
  const entry = { id: "x", containsAi: true, caption: "c" }
  assert.strictEqual(initBody(entry, 100, "direct", { sendAigcFlag: false }).post_info.is_aigc, undefined)
  assert.strictEqual(initBody(entry, 100, "direct", { sendAigcFlag: true }).post_info.is_aigc, true)
  // 下書き(inbox)には post_info 自体が無い
  assert.strictEqual(initBody(entry, 100, "inbox", { sendAigcFlag: true }).post_info, undefined)
})

test("プロンプトには制約が必ず付く", () => {
  const tpl = AI_PROMPTS.templates.find((t) => t.id === "broll-goods")
  const prompt = buildPrompt({ product: "アクスタ", mood: "落ち着いた", seconds: 5 }, tpl, AI_PROMPTS.constraints)
  assert.ok(prompt.includes("アクスタ"))
  for (const c of AI_PROMPTS.constraints) assert.ok(prompt.includes(c))
})

test("生成待ちが無ければプロンプト表はその旨を出す", () => {
  const { config } = withAiClip()
  assert.match(toMarkdown(promptSheet(config, AI_PROMPTS, {})), /生成待ちの素材がない/)
})

test("宣言するチャンク構成とアップロードの分割が一致する", () => {
  const { chunking } = require("../lib/publish")

  // 64MB 以下は分割しない
  const small = chunking(5 * 1024 * 1024)
  assert.strictEqual(small.total_chunk_count, 1)
  assert.strictEqual(small.chunk_size, 5 * 1024 * 1024)

  // 超えたら 10MB 単位。init が宣言した構成でファイル全体をちょうど覆えること
  const big = 150 * 1024 * 1024
  const { chunk_size, total_chunk_count } = chunking(big)
  assert.ok(total_chunk_count > 1)
  let covered = 0
  for (let i = 0; i < total_chunk_count; i++) {
    const start = i * chunk_size
    const end = i === total_chunk_count - 1 ? big - 1 : start + chunk_size - 1
    assert.strictEqual(start, covered, `チャンク ${i} が前のチャンクと連続していない`)
    covered = end + 1
  }
  assert.strictEqual(covered, big, "チャンクの合計がファイルサイズと一致しない")

  // initBody も同じ構成を宣言する
  const body = initBody({ id: "x", caption: "c" }, big, "inbox")
  assert.strictEqual(body.source_info.chunk_size, chunk_size)
  assert.strictEqual(body.source_info.total_chunk_count, total_chunk_count)
  assert.strictEqual(body.source_info.video_size, big)
})
