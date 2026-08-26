"use strict"

const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

/**
 * 1本の投稿動画を ffmpeg 1コマンドで組み立てる。
 *
 *   [フック動画(テキストのみ)] → [配信切り抜き(テロップ焼き込み)] を concat
 *
 * テキストは filter 文字列に直接埋めず textfile= で渡す。
 * 日本語・記号・改行のエスケープ事故を避けるため。
 */

function esc(p) {
  // drawtext のオプション値としてのパス（: と \ と ' を退避）
  return String(p).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
}

function drawtext(opts) {
  const parts = [`textfile=${esc(opts.textfile)}`, "reload=0"]
  if (opts.fontFile) parts.push(`fontfile=${esc(opts.fontFile)}`)
  parts.push(`fontsize=${opts.fontSize}`)
  parts.push(`fontcolor=${opts.color}`)
  parts.push(`line_spacing=${opts.lineSpacing || Math.round(opts.fontSize * 0.4)}`)
  parts.push("x=(w-text_w)/2")
  parts.push(opts.y)
  if (opts.box) {
    parts.push("box=1", `boxcolor=${opts.box}`, `boxborderw=${opts.boxBorder || 24}`)
  }
  else {
    parts.push("borderw=6", "bordercolor=black@0.9")
  }
  if (opts.enable) parts.push(`enable='${opts.enable}'`)
  return "drawtext=" + parts.join(":")
}

/**
 * @returns {{args: string[], textFiles: Array<{path:string,content:string}>, output: string}}
 */
function renderCommand(post, options) {
  const opts = options || {}
  const v = post.video
  const outDir = path.dirname(path.resolve(opts.cwd || ".", post.output))
  const workDir = path.join(outDir, ".text")
  const hookFile = path.join(workDir, `${post.id}.hook.txt`)
  const telopFile = path.join(workDir, `${post.id}.telop.txt`)
  const hookSeconds = v.hookSeconds
  const hasAudio = post.clipHasAudio !== false

  const filters = []
  filters.push(
    `[0:v]${drawtext({
      textfile: hookFile,
      fontFile: v.fontFile,
      fontSize: v.hookFontSize || 84,
      color: v.hookColor,
      y: "y=(h-text_h)/2",
    })},format=yuv420p,fps=${v.fps},setsar=1[hookv]`
  )
  filters.push(
    `[2:v]scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,` +
      `pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${v.fps},` +
      `${drawtext({
        textfile: telopFile,
        fontFile: v.fontFile,
        fontSize: v.telopFontSize || 56,
        color: v.telopColor,
        box: v.telopBox,
        y: `y=h-text_h-${v.telopMarginBottom || 320}`,
      })},format=yuv420p[mainv]`
  )
  // 無音のフック部分と本編の音声。1つの入力ラベルは1度しか使えないので必要なら asplit で分ける。
  // concat は各セグメントの音声フォーマットが揃っている必要がある
  const AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
  if (hasAudio) {
    filters.push(`[1:a]atrim=0:${hookSeconds},${AFMT},asetpts=N/SR/TB[hooka]`)
    filters.push(`[2:a]${AFMT},asetpts=N/SR/TB[maina]`)
  }
  else {
    filters.push(`[1:a]asplit=2[a0][a1]`)
    filters.push(`[a0]atrim=0:${hookSeconds},${AFMT},asetpts=N/SR/TB[hooka]`)
    filters.push(`[a1]atrim=0:${v.maxSeconds},${AFMT},asetpts=N/SR/TB[maina]`)
  }
  filters.push(`[hookv][hooka][mainv][maina]concat=n=2:v=1:a=1[outv][outa]`)

  const args = [
    "-y",
    "-f", "lavfi", "-t", String(hookSeconds),
    "-i", `color=c=${v.hookBg}:s=${v.width}x${v.height}:r=${v.fps}`,
    "-f", "lavfi", "-t", String(hasAudio ? hookSeconds : hookSeconds + v.maxSeconds),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-ss", String(post.clipStart || 0),
    "-t", String(v.maxSeconds),
    "-i", path.resolve(opts.cwd || ".", post.clipPath),
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", v.preset || "veryfast", "-crf", String(v.crf || 20),
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    path.resolve(opts.cwd || ".", post.output),
  ]

  return {
    args,
    output: path.resolve(opts.cwd || ".", post.output),
    textFiles: [
      { path: hookFile, content: post.hookLines.join("\n") + "\n" },
      {
        path: telopFile,
        // フックと同じく折り返す。折り返さないと長いテロップが画面外へ出る
        content: (post.telopLines && post.telopLines.length
          ? post.telopLines.join("\n")
          : post.telop || post.hookText) + "\n",
      },
    ],
  }
}

function writeTextFiles(cmd) {
  for (const f of cmd.textFiles) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true })
    fs.writeFileSync(f.path, f.content)
  }
  fs.mkdirSync(path.dirname(cmd.output), { recursive: true })
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
}

function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`
}

function toShell(cmd) {
  return ["ffmpeg"].concat(cmd.args.map(shellQuote)).join(" ")
}

function execute(cmd) {
  writeTextFiles(cmd)
  const res = spawnSync("ffmpeg", cmd.args, { stdio: "inherit" })
  return res.status === 0
}

module.exports = { renderCommand, writeTextFiles, hasFfmpeg, toShell, execute }
