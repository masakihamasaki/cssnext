"use strict"

const fs = require("fs")

/**
 * フォントのグリフ被覆チェック。
 *
 * 日本語テロップの最大の事故は「豆腐」（□□□）で、これは描画してみるまで気づかない。
 * ffmpeg はグリフが無くてもエラーにせず豆腐を焼き込むので、投稿されるまで分からない。
 * そこでフォントの cmap テーブルを直接読み、使う文字が入っているかを事前に判定する。
 *
 * 対応: TrueType/OpenType (.ttf/.otf) と TrueType Collection (.ttc)。
 * cmap は format 4（BMP）と format 12（BMP外）を読む。
 */

function u16(buf, off) {
  return buf.readUInt16BE(off)
}

function u32(buf, off) {
  return buf.readUInt32BE(off)
}

/** ファイル内の各フォントの先頭オフセット。.ttc は複数入っている。 */
function fontOffsets(buf) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "ttcf") {
    const count = u32(buf, 8)
    const offsets = []
    for (let i = 0; i < count && 12 + i * 4 + 4 <= buf.length; i++) {
      offsets.push(u32(buf, 12 + i * 4))
    }
    return offsets
  }
  return [0]
}

function findTable(buf, base, tag) {
  const numTables = u16(buf, base + 4)
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16
    if (rec + 16 > buf.length) break
    if (buf.toString("ascii", rec, rec + 4) === tag) return u32(buf, rec + 8)
  }
  return -1
}

/** cmap のサブテーブルから、コードポイント → グリフID を引く関数を作る。 */
function subtableLookup(buf, off) {
  const format = u16(buf, off)
  if (format === 4) {
    const segX2 = u16(buf, off + 6)
    const segs = segX2 / 2
    const endBase = off + 14
    const startBase = endBase + segX2 + 2
    const deltaBase = startBase + segX2
    const rangeBase = deltaBase + segX2
    return (cp) => {
      if (cp > 0xffff) return 0
      for (let i = 0; i < segs; i++) {
        const end = u16(buf, endBase + i * 2)
        if (cp > end) continue
        const start = u16(buf, startBase + i * 2)
        if (cp < start) return 0
        const delta = u16(buf, deltaBase + i * 2)
        const rangeOff = u16(buf, rangeBase + i * 2)
        if (rangeOff === 0) return (cp + delta) & 0xffff
        const gidOff = rangeBase + i * 2 + rangeOff + (cp - start) * 2
        if (gidOff + 2 > buf.length) return 0
        const gid = u16(buf, gidOff)
        return gid === 0 ? 0 : (gid + delta) & 0xffff
      }
      return 0
    }
  }
  if (format === 12) {
    const nGroups = u32(buf, off + 12)
    return (cp) => {
      for (let i = 0; i < nGroups; i++) {
        const g = off + 16 + i * 12
        if (g + 12 > buf.length) break
        const start = u32(buf, g)
        const end = u32(buf, g + 4)
        if (cp < start) return 0
        if (cp > end) continue
        return u32(buf, g + 8) + (cp - start)
      }
      return 0
    }
  }
  return null
}

/**
 * @returns {{ok: true, has: (ch: string) => boolean} | {ok: false, error: string}}
 */
function loadFont(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  }
  catch (e) {
    return { ok: false, error: `フォントを読めない: ${file}` }
  }

  const lookups = []
  for (const base of fontOffsets(buf)) {
    const cmap = findTable(buf, base, "cmap")
    if (cmap < 0) continue
    const numSub = u16(buf, cmap + 2)
    for (let i = 0; i < numSub; i++) {
      const rec = cmap + 4 + i * 8
      if (rec + 8 > buf.length) break
      const platform = u16(buf, rec)
      const encoding = u16(buf, rec + 2)
      // Unicode を引ける組み合わせだけ使う
      const unicode =
        platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
      if (!unicode) continue
      const lookup = subtableLookup(buf, cmap + u32(buf, rec + 4))
      if (lookup) lookups.push(lookup)
    }
  }
  if (!lookups.length) return { ok: false, error: `cmap を読めない: ${file}` }

  const cache = new Map()
  return {
    ok: true,
    has(ch) {
      const cp = ch.codePointAt(0)
      if (cache.has(cp)) return cache.get(cp)
      const found = lookups.some((look) => look(cp) !== 0)
      cache.set(cp, found)
      return found
    },
  }
}

/** テキスト群のうち、フォントに無い文字を返す（重複除去・改行と空白は無視）。 */
function missingGlyphs(file, texts) {
  const font = loadFont(file)
  if (!font.ok) return font
  const missing = new Set()
  for (const text of texts) {
    for (const ch of String(text)) {
      if (/\s/.test(ch)) continue
      if (!font.has(ch)) missing.add(ch)
    }
  }
  return { ok: true, missing: [...missing] }
}

module.exports = { loadFont, missingGlyphs }
