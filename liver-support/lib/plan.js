"use strict"

const path = require("path")
const { rng, addDays, ymd, jstIso, daysBetween } = require("./util")
const { chooseHook, chooseHooks, candidates, hookLines } = require("./hooks")
const { buildCaption } = require("./caption")

/**
 * 投稿計画を組む。
 *
 * 人がやるのは「どのフックが刺さるか」「どの切り抜きを見せるか」の判断で、
 * 日々の割り当て自体はここが決める。守るルールは3つ:
 *   1. 同意の無い素材・本人認可の無いアカウントは使わない（config 側で除外済み）
 *   2. 同じ素材/フックをクールダウン期間内に再利用しない
 *   3. 同じ文面を同日に複数アカウントへ横流ししない（アカウントごとに別素材・別フック）
 *
 * experiment.enabled のときは、1人につき1つの素材を「切り口テスト」に回す。
 * 同じ素材に型の違うフックを当てて intervalDays 間隔で出し、どの切り口が刺さるかを測る。
 * このときだけ素材のクールダウンを外すが、代わりに次を必ず守る:
 *   - 同時に走るテストは1ライバーにつき1本、バリエーションは maxVariants まで
 *   - バリエーションごとにフックの「型」を変える（言い回し違いでは差が出ない）
 *   - 素材に segments があれば見せどころも変える（視聴者から見て別の動画になる）
 */
function buildPlan(config, options) {
  const opts = Object.assign({ days: 7, startDate: null, seed: "lsw" }, options)
  const start = opts.startDate ? new Date(opts.startDate + "T00:00:00Z") : new Date()
  const history = ((opts.state && opts.state.posts) || []).slice()
  const posts = []
  const skipped = []
  const experimentOn =
    opts.experiment === undefined ? config.defaults.experiment.enabled : Boolean(opts.experiment)
  const experiments = new Map() // liverId → 進行中の切り口テスト

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

        // 切り口テストの出番か（1枠目のみ。2枠目は通常の割り当てに回す）
        const running = experiments.get(liver.id)
        // 走っていなければ始める。走り切っていれば次のラウンドを始める。
        const useExperiment = experimentOn && i === 0 && (!running || date >= running.nextDate)

        let clip = null
        let hook = null
        let segment = null
        let experiment = null

        if (useExperiment) {
          const started =
            running && running.remaining > 0
              ? running
              : startExperiment(liver, history, publishAt, config, seed, date)
          if (started) {
            experiments.set(liver.id, started)
            const variantIndex = started.hooks.length - started.remaining
            clip = started.clip
            hook = started.hooks[variantIndex]
            segment = started.clip.segments[variantIndex % started.clip.segments.length]
            experiment = {
              id: started.id,
              variantId: `v${variantIndex + 1}`,
              variants: started.hooks.length,
              clipId: started.clip.id,
            }
            started.remaining--
            started.nextDate = ymd(
              addDays(new Date(date + "T00:00:00Z"), config.defaults.experiment.intervalDays)
            )
          }
        }

        if (!clip) {
          clip = chooseClip(liver, history, publishAt, config, seed)
          if (!clip) {
            skipped.push({ date, liverId: liver.id, reason: "クールダウン中でない素材が無い" })
            continue
          }
          segment = clip.segments[0]
          // 進行中のテストで使う予定のフックは、通常枠で先に使わない
          const reserved = running && running.remaining > 0 ? running.hooks.map((h) => h.id) : []
          hook = chooseHook(liver, clip, config.hooks, seed, (h) => {
            if (usedTextToday.has(h.text)) return true
            if (reserved.includes(h.id)) return true
            return history.some(
              (p) =>
                p.liverId === liver.id &&
                p.hookId === h.id &&
                daysBetween(p.publishAt, publishAt) < config.defaults.hookCooldownDays
            )
          })
        }
        if (!hook) {
          skipped.push({ date, liverId: liver.id, reason: "使用可能なフックが無い" })
          continue
        }

        const caption = buildCaption(liver, clip, hook, {
          maxHashtags: config.defaults.maxHashtags,
          ai: config.defaults.ai,
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
          clipSource: clip.source || "clip",
          containsAi: clip.source === "ai",
          segmentId: segment.id,
          clipStart: segment.start || 0,
          hookId: hook.id,
          hookType: hook.type,
          hookText: hook.text,
          hookLines: hookLines(hook.text, liver.video.telopPerLine),
          telop: segment.telop || clip.telop || hook.text,
          telopLines: hookLines(segment.telop || clip.telop || hook.text, liver.video.telopPerLine),
          caption: caption.text,
          hashtags: caption.hashtags,
          video: liver.video,
          output: path.join(opts.outDir || "build", date, `${liver.id}-${i + 1}.mp4`),
        }
        if (experiment) {
          post.experimentId = experiment.id
          post.variantId = experiment.variantId
          post.variants = experiment.variants
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

/**
 * 切り口テストを1本立ち上げる。
 * 素材は通常のクールダウン判定で選び、そこに型の違うフックを maxVariants 本まで当てる。
 * 型が揃わなければ本数を減らす。無理に本数を合わせても比較にならない。
 */
function startExperiment(liver, history, publishAt, config, seed, date) {
  const exp = config.defaults.experiment
  const clip = chooseClip(liver, history, publishAt, config, seed)
  if (!clip) return null
  const blocked = (h) =>
    history.some(
      (p) =>
        p.liverId === liver.id &&
        p.hookId === h.id &&
        daysBetween(p.publishAt, publishAt) < config.defaults.hookCooldownDays
    )

  // 同じ素材を再テストするときは、前回と同じ切り口を優先して当てる。
  // ラウンドごとに切り口を総入れ替えすると1本ずつのデータが散らばり、
  // いつまでも判定に必要な本数が貯まらない。
  const experimentId = `${liver.id}:${clip.id}`
  const previous = []
  for (const p of history) {
    if (p.experimentId === experimentId && p.hookId && !previous.includes(p.hookId)) {
      previous.push(p.hookId)
    }
  }
  const pool = candidates(liver, clip, config.hooks)
  const hooks = previous
    .map((id) => pool.find((h) => h.id === id))
    .filter((h) => h && !blocked(h))
    .slice(0, exp.maxVariants)

  if (hooks.length < exp.maxVariants) {
    const usedTypes = new Set(hooks.map((h) => h.type))
    const extra = chooseHooks(
      liver,
      clip,
      config.hooks,
      `${seed}:exp`,
      exp.maxVariants - hooks.length,
      (h) => blocked(h) || usedTypes.has(h.type) || hooks.some((x) => x.id === h.id)
    )
    hooks.push(...extra)
  }
  if (hooks.length < 2) return null
  return {
    id: experimentId,
    startedAt: date,
    clip,
    hooks,
    remaining: hooks.length,
    nextDate: date,
  }
}

module.exports = { buildPlan, chooseClip, startExperiment }
