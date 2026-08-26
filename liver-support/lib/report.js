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

/**
 * 切り口テストの判定。
 *
 * 同じ素材に当てた型違いのフックを比べ、3秒維持率が最も高いものを勝ちとする。
 * ただしサンプルが薄いうちは判定しない。少ない本数で決め打つと、
 * たまたま伸びた1本を「勝ちパターン」と誤認して以後ずっと引きずる。
 */
function experiments(metrics, queue, thresholds) {
  const th = Object.assign({ minPostsPerVariant: 2, minViewsPerVariant: 1000 }, thresholds)
  const index = new Map(queue.map((q) => [q.id, q]))
  const groups = new Map()
  for (const m of metrics) {
    const q = index.get(m.post_id)
    if (!q || !q.experimentId) continue
    if (!groups.has(q.experimentId)) groups.set(q.experimentId, new Map())
    const variants = groups.get(q.experimentId)
    // 週をまたいでラウンドを重ねると同じフックに結果が積み上がる。
    // だから変化の単位（=フック）で束ねる。ラウンド内の並び順ではない。
    const key = q.hookId
    if (!variants.has(key)) {
      variants.set(key, { variantId: q.variantId, hookId: q.hookId, hookType: q.hookType, rows: [] })
    }
    variants.get(key).rows.push(m)
  }

  return [...groups.entries()].map(([id, variants]) => {
    const list = [...variants.values()]
      .map((v) => {
        const posts = v.rows.length
        const views = Math.round(mean(v.rows.map((m) => m.views || 0)))
        return {
          variantId: v.variantId,
          hookId: v.hookId,
          hookType: v.hookType,
          posts,
          views,
          retention3s: Number(mean(v.rows.map((m) => m.retention3s || 0)).toFixed(3)),
          follows: Math.round(mean(v.rows.map((m) => m.follows || 0))),
          qualified: posts >= th.minPostsPerVariant && views >= th.minViewsPerVariant,
        }
      })
      .sort((a, b) => b.retention3s - a.retention3s)

    // 判定に使うのは本数と再生数の条件を満たしたバリエーションだけ。
    // 1本しか出していない切り口を勝ち負けの材料にすると、たまたま伸びた1本を
    // 「勝ちパターン」と誤認して以後ずっと引きずる。
    const qualified = list.filter((v) => v.qualified)
    const decided = qualified.length >= 2
    return {
      id,
      variants: list,
      decided,
      winner: decided ? qualified[0] : null,
      leading: list[0] || null,
      reason: decided
        ? null
        : `判定材料が足りない（各切り口 ${th.minPostsPerVariant}本 / ${th.minViewsPerVariant}再生 以上で判定。` +
          `条件を満たしたのは ${qualified.length} 本）`,
    }
  })
}

function report(metricsFile, queue, options) {
  const metrics = parseCsv(fs.readFileSync(metricsFile, "utf8"))
  return {
    total: metrics.length,
    byHookType: aggregate(metrics, queue, "hookType"),
    byLiver: aggregate(metrics, queue, "liverId"),
    byHook: aggregate(metrics, queue, "hookId"),
    experiments: experiments(metrics, queue, options && options.experiment),
  }
}

module.exports = { report, aggregate, parseCsv, experiments }
