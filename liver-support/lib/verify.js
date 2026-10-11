"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const { renderCommand, execute } = require("./render")
const { missingGlyphs } = require("./font")
const { hookLines } = require("./hooks")
const { wrapJa } = require("./util")

/**
 * 実際に ffmpeg を回して出力を検査する自己診断。
 *
 * 動画は「コマンドが組み立てられた」ことと「意図した動画になった」ことが別物で、
 * 後者はテストコードでは分からない。ここだけは本物を1本焼いて中身を測る。
 * CI から呼ばれる前提なので、素材は自前で合成して外部依存を作らない。
 */

function run(bin, args, opts) {
  return spawnSync(bin, args, Object.assign({ maxBuffer: 1 << 28 }, opts))
}

function probe(file) {
  const res = run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,pix_fmt",
    "-of", "json",
    file,
  ])
  if (res.status !== 0) return null
  return JSON.parse(res.stdout.toString())
}

/** 指定秒のフレームを切り出し、グレースケールの生バイトで返す。 */
function grayFrame(file, at, crop) {
  const filters = [crop ? `crop=${crop}` : null, "format=gray"].filter(Boolean).join(",")
  const res = run("ffmpeg", [
    "-v", "error", "-ss", String(at), "-i", file,
    "-frames:v", "1", "-vf", filters, "-f", "rawvideo", "-",
  ])
  return res.status === 0 ? res.stdout : null
}

function ink(buf, threshold) {
  if (!buf || !buf.length) return null
  let max = 0
  let bright = 0
  for (const v of buf) {
    if (v > max) max = v
    if (v >= (threshold || 200)) bright++
  }
  return { max, brightRatio: bright / buf.length }
}

/** 検証用の素材を合成する。実素材が無くても検証が回るようにするため。 */
function makeClip(file, opts) {
  const o = Object.assign({ seconds: 30, width: 1280, height: 720, audio: true }, opts)
  const args = ["-y", "-v", "error", "-f", "lavfi", "-t", String(o.seconds),
    "-i", `testsrc2=s=${o.width}x${o.height}:r=30`]
  if (o.audio) {
    args.push("-f", "lavfi", "-t", String(o.seconds), "-i", "sine=frequency=440:sample_rate=44100")
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
  if (o.audio) args.push("-c:a", "aac")
  args.push("-shortest", file)
  return run("ffmpeg", args).status === 0
}

function check(results, name, ok, detail) {
  results.push({ name, ok, detail })
  return ok
}

/**
 * @returns {{results: Array, ok: boolean, dir: string}}
 */
function verify(options) {
  const opts = options || {}
  const results = []
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), "lsw-verify-"))
  fs.mkdirSync(dir, { recursive: true })

  const fontFile = opts.fontFile || ""
  const video = Object.assign(
    {
      width: 1080, height: 1920, fps: 30, hookSeconds: 2.5, maxSeconds: 12,
      hookBg: "0x0E0E12", hookColor: "white", telopColor: "white",
      telopBox: "0x000000@0.45", hookFontSize: 84, telopFontSize: 56,
      telopMarginBottom: 320, fontFile,
    },
    opts.video
  )

  const hookText = opts.hookText || "読み間違いを30秒で見せます"
  const telopText = opts.telopText || "コメント、盛大に読み間違えた"

  // 1. フォントのグリフ被覆。ここが欠けると豆腐が焼き込まれる
  if (fontFile) {
    const glyphs = missingGlyphs(fontFile, [hookText, telopText])
    check(
      results,
      "フォントのグリフ被覆",
      glyphs.ok && glyphs.missing.length === 0,
      glyphs.ok
        ? glyphs.missing.length
          ? `フォントに無い文字: ${glyphs.missing.join("")}（豆腐になる）`
          : `${path.basename(fontFile)} に全ての文字がある`
        : glyphs.error
    )
  }
  else {
    check(results, "フォントのグリフ被覆", false, "fontFile 未指定（日本語は豆腐になる）")
  }

  // 2. 音声あり素材での実ビルド
  const clip = path.join(dir, "clip.mp4")
  if (!check(results, "検証用素材の合成", makeClip(clip, { seconds: 30 }), clip)) {
    return { results, ok: false, dir }
  }

  const clipStart = 4
  const post = {
    id: "verify-1",
    clipPath: clip,
    clipStart,
    hookText,
    hookLines: hookLines(hookText, 12),
    telop: telopText,
    telopLines: wrapJa(telopText, 12),
    video,
    output: path.join(dir, "out.mp4"),
  }
  const cmd = renderCommand(post)
  if (!check(results, "実ビルド（音声あり素材）", execute(cmd), cmd.output)) {
    return { results, ok: false, dir }
  }

  const info = probe(cmd.output)
  const v = info && info.streams.find((s) => s.codec_type === "video")
  const a = info && info.streams.find((s) => s.codec_type === "audio")
  const expected = video.hookSeconds + video.maxSeconds

  check(results, "解像度", Boolean(v) && v.width === video.width && v.height === video.height,
    v ? `${v.width}x${v.height}（期待 ${video.width}x${video.height}）` : "映像ストリームが無い")
  check(results, "フレームレート", Boolean(v) && v.r_frame_rate === `${video.fps}/1`,
    v ? `${v.r_frame_rate}（期待 ${video.fps}/1）` : "-")
  check(results, "ピクセルフォーマット", Boolean(v) && v.pix_fmt === "yuv420p",
    v ? v.pix_fmt : "-")
  check(results, "音声トラック", Boolean(a), a ? a.codec_type : "音声が消えている")

  const duration = info ? Number(info.format.duration) : 0
  check(results, "尺 = フック + 本編", Math.abs(duration - expected) < 0.5,
    `${duration.toFixed(2)}秒（期待 ${expected}秒）`)

  // 3. 文字が実際に焼き込まれているか（真っ黒なカードが出ていないか）
  const band = `${video.width}:600:0:${Math.round(video.height / 2 - 300)}`
  const hookInk = ink(grayFrame(cmd.output, video.hookSeconds / 2, band))
  check(results, "フックの文字が描画されている",
    Boolean(hookInk) && hookInk.max > 200 && hookInk.brightRatio > 0.002,
    hookInk ? `最大輝度 ${hookInk.max} / 明部率 ${(hookInk.brightRatio * 100).toFixed(2)}%` : "フレームを取得できない")

  const telopBand = `${video.width}:400:0:${video.height - video.telopMarginBottom - 400}`
  const telopInk = ink(grayFrame(cmd.output, video.hookSeconds + 3, telopBand))
  check(results, "テロップの文字が描画されている",
    Boolean(telopInk) && telopInk.max > 200 && telopInk.brightRatio > 0.002,
    telopInk ? `最大輝度 ${telopInk.max} / 明部率 ${(telopInk.brightRatio * 100).toFixed(2)}%` : "フレームを取得できない")

  // 4. 目視確認用のフレームを残す。数値は通っても「見た目が変」は人にしか分からない
  for (const [name, at] of [["hook", video.hookSeconds / 2], ["main", video.hookSeconds + 3]]) {
    const png = path.join(dir, `frame-${name}.png`)
    run("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", cmd.output, "-frames:v", "1", png])
    if (fs.existsSync(png)) results.push({ name: `目視用フレーム(${name})`, ok: true, detail: png })
  }

  // 5. 音声の無い素材でも壊れないこと（clipHasAudio: false の経路）
  const silent = path.join(dir, "silent.mp4")
  if (check(results, "検証用素材の合成（無音）", makeClip(silent, { seconds: 20, audio: false }), silent)) {
    const silentPost = Object.assign({}, post, {
      id: "verify-2",
      clipPath: silent,
      clipHasAudio: false,
      output: path.join(dir, "out-silent.mp4"),
    })
    const silentCmd = renderCommand(silentPost)
    if (check(results, "実ビルド（無音素材）", execute(silentCmd), silentCmd.output)) {
      const si = probe(silentCmd.output)
      const sd = si ? Number(si.format.duration) : 0
      check(results, "無音素材でも尺が合う", Math.abs(sd - expected) < 0.5,
        `${sd.toFixed(2)}秒（期待 ${expected}秒）`)
      check(results, "無音素材でも音声トラックがある",
        Boolean(si && si.streams.some((s) => s.codec_type === "audio")),
        "concat には両セグメントに音声が要る")
    }
  }

  return { results, ok: results.every((r) => r.ok), dir }
}

function hasFfprobe() {
  return run("ffprobe", ["-version"], { stdio: "ignore" }).status === 0
}

module.exports = { verify, hasFfprobe, probe, grayFrame, ink, makeClip }
