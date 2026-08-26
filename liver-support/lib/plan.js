"use strict"

const path = require("path")
const { rng, addDays, ymd, jstIso, daysBetween } = require("./util")
const { chooseHook, hookLines } = require("./hooks")
const { buildCaption } = require("./caption")

/**
 * 投稿計画を組む。
 *
 * 人がやるのは「どのフックが刺さるか」「どの切り抜きを見せるか」の判断で、
 * 日々の割り当て自体はここが決める。守るルールは3つ:
 *   1. 同意の無い素材・本人認可の無いアカウントは使わない（config 側で除外済み）
 *   2. 同じ素材/フックをクールダウン期間内に再利用しない
 *   3. 同じ文面を同日に複数アカウントへ横流ししない（アカウントごとに別素材・別フック）
 */
function buildPlan(config, options) {
  const opts = Object.assign({ days: 7, startDate: null, seed: "lsw" }, options)
  const start = opts.startDate ? new Date(opts.startDate + "T00:00:00Z") : new Date()
  const history = ((opts.state && opts.state.posts) || []).slice()
  const posts = []
  const skipped = []

  for (let d = 0; d < opts.days; d++) {
    const date = ymd(addDays(start, d))
    const usedTextToday = new Set(
      history.filter((p) => p.date === date).map((p) => p.hookText)
    )

    for (const liver of config.livers) {
      const times = liver.postTimes.slice(0, liver.postsPerDay || config.defaults.postsPerDay)
      for (let i = 0; i < times.length; i++) {
        const account = liver.accounts[(d + i) % liver.accounts.length]
        const publishAt = jstIso(date, times[i])
        const seed = `${opts.seed}:${liver.id}:${account.handle}:${date}:${i}`

        const clip = chooseClip(liver, history, publishAt, config, seed)
        if (!clip) {
          skipped.push({ date, liverId: liver.id, reason: "クールダウン中でない素材が無い" })
          continue
        }

        const hook = chooseHook(liver, clip, config.hooks, seed, (h) => {
          if (usedTextToday.has(h.text)) return true
          return history.some(
            (p) =>
              p.liverId === liver.id &&
              p.hookId === h.id &&
              daysBetween(p.publishAt, publishAt) < config.defaults.hookCooldownDays
          )
        })
        if (!hook) {
          skipped.push({ date, liverId: liver.id, reason: "使用可能なフックが無い" })
          continue
        }

        const caption = buildCaption(liver, clip, hook, {
          maxHashtags: config.defaults.maxHashtags,
        })
        const id = `${date}-${liver.id}-${i + 1}`
        const post = {
          id,
          date,
          publishAt,
          liverId: liver.id,
          liverName: liver.name,
          platform: account.platform || "tiktok",
          handle: account.handle,
          tokenEnv: account.tokenEnv,
          clipId: clip.id,
          clipPath: clip.path,
          clipStart: clip.highlightAt || 0,
          hookId: hook.id,
          hookType: hook.type,
          hookText: hook.text,
          hookLines: hookLines(hook.text, liver.video.telopPerLine),
          telop: clip.telop || hook.text,
          caption: caption.text,
          hashtags: caption.hashtags,
          video: liver.video,
          output: path.join(opts.outDir || "build", date, `${liver.id}-${i + 1}.mp4`),
        }
        posts.push(post)
        usedTextToday.add(hook.text)
        history.push(post)
      }
    }
  }

  return { generatedFor: ymd(start), days: opts.days, seed: opts.seed, posts, skipped }
}

/** 直近で使っていない素材を優先。同点はシードで決める（毎回同じ結果になる）。 */
function chooseClip(liver, history, publishAt, config, seed) {
  const cooldown = config.defaults.clipCooldownDays
  const lastUse = new Map()
  for (const p of history) {
    if (p.liverId !== liver.id) continue
    const prev = lastUse.get(p.clipId)
    if (!prev || new Date(p.publishAt) > new Date(prev)) lastUse.set(p.clipId, p.publishAt)
  }
  const usable = liver.clips.filter((c) => {
    const last = lastUse.get(c.id)
    return !last || daysBetween(last, publishAt) >= cooldown
  })
  if (!usable.length) return null

  const next = rng(seed)
  return usable
    .map((c) => ({
      c,
      // 未使用 → 最優先。使用済みは古い順。
      k: lastUse.has(c.id) ? new Date(lastUse.get(c.id)).getTime() : 0,
      j: next(),
    }))
    .sort((a, b) => a.k - b.k || a.j - b.j)[0].c
}

module.exports = { buildPlan, chooseClip }
