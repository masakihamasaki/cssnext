"use strict"

const TIKTOK_CAPTION_MAX = 2200

function normalizeTag(tag) {
  const t = String(tag).trim()
  return t.startsWith("#") ? t : "#" + t
}

/**
 * 投稿キャプション。
 * 1行目はフック文と別の言い回しにする（同じ文字が動画とキャプションで重複すると読み飛ばされる）。
 */
function buildCaption(liver, clip, hook, opts) {
  const max = (opts && opts.maxHashtags) || 5
  const ai = (opts && opts.ai) || {}
  const isAi = clip.source === "ai"
  const tags = []
  // AI生成の開示タグは上限に関わらず最初に入れる（枠が埋まって落ちてはいけない）
  if (isAi && ai.disclosureTag) tags.push(normalizeTag(ai.disclosureTag))
  for (const t of (liver.hashtags || []).concat((clip.tags || []).map(normalizeTag))) {
    const tag = normalizeTag(t)
    if (!tags.includes(tag)) tags.push(tag)
    if (tags.length >= max) break
  }
  const lines = [
    clip.caption || hook.text,
    liver.cta || `${liver.name}の配信はプロフィールから`,
    isAi ? ai.disclosureText || "※この動画にはAI生成の映像が含まれます" : null,
    tags.join(" "),
  ].filter(Boolean)

  let text = lines.join("\n")
  if (text.length > TIKTOK_CAPTION_MAX) {
    text = text.slice(0, TIKTOK_CAPTION_MAX - 1) + "…"
  }
  return { text, hashtags: tags, containsAi: isAi }
}

module.exports = { buildCaption, normalizeTag, TIKTOK_CAPTION_MAX }
