"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { test } = require("node:test")

const { loadConfig } = require("../lib/config")
const { buildPlan } = require("../lib/plan")
const { makeWorkspace } = require("../test-utils/fixtures")

test("同意の無い素材は計画に乗らない", () => {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  raw.livers[0].clips[0].consent = false
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))

  const config = loadConfig(ws.configPath)
  const ids = config.livers[0].clips.map((c) => c.id)
  assert.deepStrictEqual(ids, ["c2", "c3"])
  assert.ok(config.warnings.some((w) => w.includes("同意")))

  const plan = buildPlan(config, { days: 5, startDate: "2026-09-01" })
  assert.ok(plan.posts.every((p) => p.clipId !== "c1"))
})

test("本人認可の無いアカウントは除外され、アカウントが無いライバーはスキップされる", () => {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  delete raw.livers[0].accounts[0].authorizedAt
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))

  const config = loadConfig(ws.configPath)
  assert.strictEqual(config.livers.length, 0)
  assert.ok(config.warnings.some((w) => w.includes("本人認可")))
})

test("素材はクールダウン期間内に再利用されない", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const plan = buildPlan(config, { days: 3, startDate: "2026-09-01" })
  const clips = plan.posts.map((p) => p.clipId)
  assert.strictEqual(new Set(clips).size, clips.length)
})

test("クールダウンが明けた素材は再び使われる", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath) // 素材3本 / クールダウン3日
  const plan = buildPlan(config, { days: 5, startDate: "2026-09-01" })
  assert.strictEqual(plan.posts.length, 5)
  assert.strictEqual(plan.skipped.length, 0)
  assert.strictEqual(plan.posts[3].clipId, plan.posts[0].clipId)
})

test("素材が尽きたら投稿枠を埋めずに skip する（使い回さない）", () => {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  raw.defaults.clipCooldownDays = 30
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))

  const config = loadConfig(ws.configPath) // 素材3本 / クールダウン30日
  const plan = buildPlan(config, { days: 5, startDate: "2026-09-01" })
  assert.strictEqual(plan.posts.length, 3)
  assert.strictEqual(plan.skipped.length, 2)
  assert.ok(plan.skipped[0].reason.includes("クールダウン"))
})

test("直近で使ったフックは選ばれない", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const plan = buildPlan(config, { days: 3, startDate: "2026-09-01" })
  const hooks = plan.posts.map((p) => p.hookId)
  assert.strictEqual(new Set(hooks).size, hooks.length)
})

test("同じ seed なら同じ計画、違う seed なら別の計画", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const a = buildPlan(config, { days: 3, startDate: "2026-09-01", seed: "x" })
  const b = buildPlan(config, { days: 3, startDate: "2026-09-01", seed: "x" })
  const c = buildPlan(config, { days: 3, startDate: "2026-09-01", seed: "y" })
  assert.deepStrictEqual(a.posts.map((p) => p.hookId), b.posts.map((p) => p.hookId))
  assert.notDeepStrictEqual(a.posts.map((p) => p.hookId + p.clipId), c.posts.map((p) => p.hookId + p.clipId))
})

test("履歴(state)を渡すと過去の投稿もクールダウン判定に入る", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const state = {
    posts: [
      { liverId: "hina", clipId: "c1", hookId: "kyokan-01", hookText: "x", publishAt: "2026-09-01T19:30:00+09:00", date: "2026-09-01" },
      { liverId: "hina", clipId: "c2", hookId: "kyokan-02", hookText: "y", publishAt: "2026-09-01T19:30:00+09:00", date: "2026-09-01" },
    ],
  }
  const plan = buildPlan(config, { days: 1, startDate: "2026-09-02", state })
  assert.strictEqual(plan.posts.length, 1)
  assert.strictEqual(plan.posts[0].clipId, "c3")
})

test("複数アカウントでも同日に同じ文面を横流ししない", () => {
  const ws = makeWorkspace()
  const raw = JSON.parse(fs.readFileSync(ws.configPath, "utf8"))
  raw.defaults.postTimes = ["19:30", "22:00"]
  raw.livers[0].postsPerDay = 2
  raw.livers[0].accounts.push({
    platform: "tiktok",
    handle: "@hina_clips",
    tokenEnv: "TIKTOK_TOKEN_HINA2",
    authorizedAt: "2026-08-01",
  })
  fs.writeFileSync(ws.configPath, JSON.stringify(raw))

  const config = loadConfig(ws.configPath)
  const plan = buildPlan(config, { days: 1, startDate: "2026-09-01" })
  assert.strictEqual(plan.posts.length, 2)
  assert.notStrictEqual(plan.posts[0].handle, plan.posts[1].handle)
  assert.notStrictEqual(plan.posts[0].hookText, plan.posts[1].hookText)
  assert.notStrictEqual(plan.posts[0].clipId, plan.posts[1].clipId)
})

test("計画には投稿に必要な情報が揃っている", () => {
  const ws = makeWorkspace()
  const config = loadConfig(ws.configPath)
  const post = buildPlan(config, { days: 1, startDate: "2026-09-01" }).posts[0]
  assert.match(post.publishAt, /^2026-09-01T19:30:00\+09:00$/)
  assert.ok(post.hookText.length > 0)
  assert.ok(post.hookLines.length > 0)
  assert.ok(post.caption.includes("#"))
  assert.ok(post.output.endsWith(".mp4"))
  assert.ok(fs.existsSync(post.clipPath))
  assert.strictEqual(path.isAbsolute(post.clipPath), true)
})
