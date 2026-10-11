"use strict"

const assert = require("assert")
const fs = require("fs")
const { test } = require("node:test")

const { loadConfig } = require("../lib/config")
const { buildPlan } = require("../lib/plan")
const { experiments } = require("../lib/report")
const { chooseHooks } = require("../lib/hooks")
const { makeWorkspace } = require("../test-utils/fixtures")

function withExperiment(extra) {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  raw.defaults.experiment = Object.assign(
    { enabled: true, maxVariants: 3, intervalDays: 3, minPostsPerVariant: 2, minViewsPerVariant: 1000 },
    extra
  )
  for (const clip of raw.livers[0].clips) {
    clip.segments = [
      { id: `${clip.id}-a`, start: 0, telop: "冒頭" },
      { id: `${clip.id}-b`, start: 10, telop: "中盤" },
      { id: `${clip.id}-c`, start: 20, telop: "終盤" },
    ]
  }
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))
  return loadConfig(ws.configPath)
}

test("切り口テストは同じ素材に型の違うフックを当てる", () => {
  const config = withExperiment()
  const plan = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: true })
  const variants = plan.posts.filter((p) => p.experimentId)
  assert.strictEqual(variants.length, 3)
  assert.strictEqual(new Set(variants.map((p) => p.clipId)).size, 1)
  assert.strictEqual(new Set(variants.map((p) => p.hookType)).size, 3)
  assert.deepStrictEqual(variants.map((p) => p.variantId), ["v1", "v2", "v3"])
})

test("バリエーションは見せどころも変える", () => {
  const config = withExperiment()
  const variants = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: true }).posts
    .filter((p) => p.experimentId)
  const clipId = variants[0].clipId
  assert.deepStrictEqual(
    variants.map((p) => p.segmentId),
    [`${clipId}-a`, `${clipId}-b`, `${clipId}-c`]
  )
  assert.deepStrictEqual(variants.map((p) => p.clipStart), [0, 10, 20])
})

test("segments が無い素材ではフックだけが変わる（見せどころは同じ）", () => {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  raw.defaults.experiment = { enabled: true, maxVariants: 3, intervalDays: 3 }
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))
  const config = loadConfig(ws.configPath)
  const variants = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: true }).posts
    .filter((p) => p.experimentId)
  assert.strictEqual(new Set(variants.map((p) => p.segmentId)).size, 1)
  assert.strictEqual(new Set(variants.map((p) => p.hookType)).size, variants.length)
})

test("バリエーションは intervalDays 間隔で出る（連日にはしない）", () => {
  const config = withExperiment({ intervalDays: 3 })
  const dates = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: true }).posts
    .filter((p) => p.experimentId)
    .map((p) => p.date)
  assert.deepStrictEqual(dates, ["2026-09-01", "2026-09-04", "2026-09-07"])
})

test("テストで使う予定のフックは通常枠で先に使われない", () => {
  const config = withExperiment()
  const plan = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: true })
  const planned = plan.posts.filter((p) => p.experimentId)
  const normal = plan.posts.filter((p) => !p.experimentId)
  for (const n of normal) {
    const laterVariant = planned.some((v) => v.hookId === n.hookId && v.date > n.date)
    assert.strictEqual(laterVariant, false, `${n.hookId} がテスト前に通常枠で使われている`)
  }
})

test("experiment: false なら従来どおり1素材1フック", () => {
  const config = withExperiment()
  const plan = buildPlan(config, { days: 9, startDate: "2026-09-01", experiment: false })
  assert.strictEqual(plan.posts.filter((p) => p.experimentId).length, 0)
})

test("同じ素材を再テストすると同じ切り口が積み上がる", () => {
  const config = withExperiment()
  const plan = buildPlan(config, { days: 60, startDate: "2026-09-01", experiment: true })
  const byExp = plan.posts.filter((p) => p.experimentId === plan.posts[0].experimentId)
  const counts = {}
  for (const p of byExp) counts[p.hookId] = (counts[p.hookId] || 0) + 1
  assert.ok(Math.max(...Object.values(counts)) >= 2, "同じフックが複数ラウンドに出ていない")
})

test("型の異なるフックを n 本選ぶ", () => {
  const config = withExperiment()
  const liver = config.livers[0]
  const picked = chooseHooks(liver, liver.clips[0], config.hooks, "seed", 3)
  assert.strictEqual(picked.length, 3)
  assert.strictEqual(new Set(picked.map((h) => h.type)).size, 3)
})

const QUEUE = [
  { id: "a1", experimentId: "hina:c1", variantId: "v1", hookId: "h1", hookType: "共感" },
  { id: "a2", experimentId: "hina:c1", variantId: "v2", hookId: "h2", hookType: "意外性" },
  { id: "a3", experimentId: "hina:c1", variantId: "v1", hookId: "h1", hookType: "共感" },
  { id: "a4", experimentId: "hina:c1", variantId: "v2", hookId: "h2", hookType: "意外性" },
  { id: "b1", liverId: "hina", hookId: "h3", hookType: "問いかけ" },
]

test("判定材料が揃った切り口だけで勝ちを決める", () => {
  const metrics = [
    { post_id: "a1", views: 5000, retention3s: 0.4 },
    { post_id: "a2", views: 6000, retention3s: 0.7 },
    { post_id: "a3", views: 5000, retention3s: 0.42 },
    { post_id: "a4", views: 6000, retention3s: 0.68 },
  ]
  const [exp] = experiments(metrics, QUEUE, { minPostsPerVariant: 2, minViewsPerVariant: 1000 })
  assert.strictEqual(exp.id, "hina:c1")
  assert.strictEqual(exp.decided, true)
  assert.strictEqual(exp.winner.hookId, "h2")
  assert.strictEqual(exp.variants.every((v) => v.qualified), true)
})

test("本数が足りなければ判定せず、先行だけ示す", () => {
  const metrics = [
    { post_id: "a1", views: 5000, retention3s: 0.4 },
    { post_id: "a2", views: 6000, retention3s: 0.7 },
  ]
  const [exp] = experiments(metrics, QUEUE, { minPostsPerVariant: 2, minViewsPerVariant: 1000 })
  assert.strictEqual(exp.decided, false)
  assert.strictEqual(exp.winner, null)
  assert.strictEqual(exp.leading.hookId, "h2")
  assert.match(exp.reason, /判定材料が足りない/)
})

test("再生数が閾値に届かない切り口は判定に使わない", () => {
  const metrics = [
    { post_id: "a1", views: 100, retention3s: 0.9 },
    { post_id: "a3", views: 100, retention3s: 0.9 },
    { post_id: "a2", views: 6000, retention3s: 0.5 },
    { post_id: "a4", views: 6000, retention3s: 0.5 },
  ]
  const [exp] = experiments(metrics, QUEUE, { minPostsPerVariant: 2, minViewsPerVariant: 1000 })
  assert.strictEqual(exp.decided, false)
  assert.strictEqual(exp.variants.find((v) => v.hookId === "h1").qualified, false)
})

test("テスト外の投稿は集計に混ざらない", () => {
  const metrics = [{ post_id: "b1", views: 9000, retention3s: 0.99 }]
  assert.deepStrictEqual(experiments(metrics, QUEUE, {}), [])
})
