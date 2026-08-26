"use strict"

/**
 * 依存ゼロの小物ユーティリティ。
 * 乱数は必ずシード付き（同じ入力 → 同じ投稿計画）。運用でブレると検証ができないため。
 */

// mulberry32: 軽量な決定論的 PRNG
function rng(seedText) {
  let h = 1779033703 ^ String(seedText).length
  for (let i = 0; i < String(seedText).length; i++) {
    h = Math.imul(h ^ String(seedText).charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(list, next) {
  return list[Math.floor(next() * list.length) % list.length]
}

/**
 * 日本語テロップ用の折り返し。
 * 単語境界がないので文字数で折る。句読点は行頭に送らない。
 */
function wrapJa(text, perLine) {
  const max = perLine || 12
  const lines = []
  let line = ""
  for (const ch of String(text).replace(/\s+/g, " ").trim()) {
    if (ch === "\n") {
      lines.push(line)
      line = ""
      continue
    }
    if (line.length >= max && !"、。！？」".includes(ch)) {
      lines.push(line)
      line = ""
    }
    line += ch
  }
  if (line) lines.push(line)
  return lines
}

function addDays(date, days) {
  const d = new Date(date.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function ymd(date) {
  return date.toISOString().slice(0, 10)
}

/** JST の "YYYY-MM-DD" + "HH:MM" を ISO8601(+09:00) に。 */
function jstIso(dateStr, timeStr) {
  return `${dateStr}T${timeStr.length === 5 ? timeStr : timeStr + ":00"}:00+09:00`
    .replace(/(:\d{2}):00\+/, "$1:00+")
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  return Math.abs(a - b) / 86400000
}

function template(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, key) =>
    vars[key] === undefined || vars[key] === null ? "" : String(vars[key])
  )
}

module.exports = { rng, pick, wrapJa, addDays, ymd, jstIso, daysBetween, template }
