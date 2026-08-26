"use strict"

const fs = require("fs")
const path = require("path")

/** 投稿計画 → 投稿キュー（1行1投稿の JSONL）。publish はこのファイルだけを見る。 */
function toQueue(plan) {
  return plan.posts.map((p) => ({
    id: p.id,
    status: "pending",
    publishAt: p.publishAt,
    platform: p.platform,
    handle: p.handle,
    tokenEnv: p.tokenEnv,
    liverId: p.liverId,
    hookId: p.hookId,
    hookType: p.hookType,
    clipId: p.clipId,
    segmentId: p.segmentId,
    clipSource: p.clipSource,
    containsAi: Boolean(p.containsAi),
    experimentId: p.experimentId,
    variantId: p.variantId,
    video: p.output,
    caption: p.caption,
  }))
}

function writeQueue(file, entries) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
}

function readQueue(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** 予約時刻を過ぎた pending だけを対象にする。 */
function due(entries, now) {
  const t = (now ? new Date(now) : new Date()).getTime()
  return entries.filter((e) => e.status === "pending" && new Date(e.publishAt).getTime() <= t)
}

module.exports = { toQueue, writeQueue, readQueue, due }
