"use strict"

const { template, rng, wrapJa } = require("./util")

/**
 * フック文の生成。
 * 「AI に1本作らせる」のではなく、型（hookType）× 変数（ライバー/切り抜きの中身）で
 * 組み合わせを量産する。LLM を使う場合も、この型と変数をプロンプトに渡すのが前提。
 */
function hookVars(liver, clip) {
  return {
    name: liver.name,
    genre: liver.genre || "配信",
    topic: clip.topic || clip.title,
    title: clip.title,
    tag: (clip.tags || [])[0] || liver.genre || "配信",
    time: liver.streamTime || "毎晩",
    cta: liver.cta || "プロフィールから配信へ",
  }
}

function candidates(liver, clip, hooks) {
  const allow = liver.hookTypes && liver.hookTypes.length ? liver.hookTypes : null
  const vars = hookVars(liver, clip)
  return hooks
    .filter((h) => !allow || allow.includes(h.type))
    .filter((h) => !h.requires || h.requires.every((k) => vars[k]))
    .map((h) => ({
      id: h.id,
      type: h.type,
      text: template(h.template, vars).trim(),
    }))
    .filter((h) => h.text.length > 0)
}

/** 決定論的に1本選ぶ。seed には日付・ライバー・素材を必ず含める。 */
function chooseHook(liver, clip, hooks, seed, isBlocked) {
  const list = candidates(liver, clip, hooks)
  if (!list.length) return null
  const next = rng(seed)
  const order = list
    .map((h) => ({ h, k: next() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.h)
  return order.find((h) => !isBlocked || !isBlocked(h)) || null
}

/** テロップ用に行分割したフック。1行あたりの文字数は縦動画の可読性から12文字が既定。 */
function hookLines(text, perLine) {
  return wrapJa(text, perLine || 12)
}

module.exports = { hookVars, candidates, chooseHook, hookLines }
