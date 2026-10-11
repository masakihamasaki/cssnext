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
 *
 * 単語境界が無いので文字数で折るが、素朴に切ると読みにくい場所で切れる。
 * 実際に描画して分かった問題を3つ潰している:
 *   - 「30秒」のような数字と単位の間で切れる
 *   - 最終行が1〜2文字だけ残る（「…見せ / ます」）
 *   - 句読点が行頭に来る
 * そこで、分割してはいけない塊に切ってから、行数を決めて均等に配れる。
 */

// 行頭に置かない文字（終わり括弧・句読点・小書き仮名・長音）
const NO_LINE_START = "、。，．！？」』）】〉》”’ぁぃぅぇぉっゃゅょゎヵヶァィゥェォッャュョヮーぐ々"
// 行末に置かない文字（始め括弧）
const NO_LINE_END = "「『（【〈《“‘"

/** 分割してはいけない塊に切る。数字＋単位、英単語、それ以外は1文字。 */
function tokenizeJa(text) {
  const src = String(text).replace(/\s+/g, " ").trim()
  const tokens = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    // 数字（小数・カンマ区切り含む）と、続く単位1文字までを1塊にする
    const num = /^[0-9０-９]+(?:[.,][0-9０-９]+)*[%％位倍人回本個円分秒時日週月年名点件]?/.exec(rest)
    if (num) {
      tokens.push(num[0])
      i += num[0].length
      continue
    }
    const word = /^[A-Za-zＡ-Ｚａ-ｚ]+/.exec(rest)
    if (word) {
      tokens.push(word[0])
      i += word[0].length
      continue
    }
    tokens.push(src[i])
    i += 1
  }
  return tokens
}

function wrapJa(text, perLine) {
  const max = perLine || 12
  const tokens = tokenizeJa(text)
  const total = tokens.reduce((n, t) => n + t.length, 0)
  if (!total) return []

  // 行数を先に決めて均等に配る。貪欲に詰めると最終行が余りだけになる。
  const lineCount = Math.max(1, Math.ceil(total / max))
  const target = Math.ceil(total / lineCount)

  const lines = []
  let line = ""
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const next = tokens[i + 1]
    const wouldBreak =
      line.length > 0 &&
      line.length + token.length > target &&
      // 行頭に置けない文字は前の行に残す
      !NO_LINE_START.includes(token[0]) &&
      // 行末に置けない文字は次の行へ送る
      !NO_LINE_END.includes(line[line.length - 1])
    if (wouldBreak && line.length + token.length > max) {
      lines.push(line)
      line = ""
    }
    else if (wouldBreak && lines.length < lineCount - 1) {
      // 上限には収まるが、目標を超えたので次の行へ（行数は増やさない）
      lines.push(line)
      line = ""
    }
    line += token
    // 最後の塊まで来たら残りを出す
    if (i === tokens.length - 1) lines.push(line)
    else if (!next) lines.push(line)
  }
  return lines.filter((l) => l.length)
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

module.exports = { rng, pick, wrapJa, tokenizeJa, addDays, ymd, jstIso, daysBetween, template }
