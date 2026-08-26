"use strict"

const fs = require("fs")

/**
 * 投稿結果 CSV を読み、フック型 / ライバー別に成績を集計する。
 * 「どのフックが刺さるか」を人が判断するための材料であって、自動最適化はしない。
 *
 * CSV: post_id,views,retention3s,profile_views,follows,gifts
 *   retention3s は 0-1（3秒視聴維持率）。フックの良し悪しはここに一番出る。
 */
function parseCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/)
  const cols = head.split(",").map((c) => c.trim())
  return rows.filter((r) => r.trim()).map((r) => {
    const cells = r.split(",")
    const o = {}
    cols.forEach((c, i) => {
      const raw = (cells[i] || "").trim()
      o[c] = raw === "" || isNaN(Number(raw)) ? raw : Number(raw)
    })
    return o
  })
}

function mean(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0
}

function aggregate(metrics, queue, key) {
  const index = new Map(queue.map((q) => [q.id, q]))
  const groups = new Map()
  for (const m of metrics) {
    const q = index.get(m.post_id)
    if (!q) continue
    const k = q[key] || "(不明)"
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(m)
  }
  return [...groups.entries()]
    .map(([k, list]) => ({
      key: k,
      posts: list.length,
      views: Math.round(mean(list.map((m) => m.views || 0))),
      retention3s: Number(mean(list.map((m) => m.retention3s || 0)).toFixed(3)),
      profileViews: Math.round(mean(list.map((m) => m.profile_views || 0))),
      follows: Math.round(mean(list.map((m) => m.follows || 0))),
      // プロフィール遷移率 = 配信への導線がどれだけ効いたか
      ctr: Number((mean(list.map((m) => (m.views ? m.profile_views / m.views : 0))) * 100).toFixed(2)),
    }))
    .sort((a, b) => b.retention3s - a.retention3s)
}

function report(metricsFile, queue) {
  const metrics = parseCsv(fs.readFileSync(metricsFile, "utf8"))
  return {
    total: metrics.length,
    byHookType: aggregate(metrics, queue, "hookType"),
    byLiver: aggregate(metrics, queue, "liverId"),
    byHook: aggregate(metrics, queue, "hookId"),
  }
}

module.exports = { report, aggregate, parseCsv }
