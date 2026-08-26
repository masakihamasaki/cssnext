"use strict"

const fs = require("fs")
const path = require("path")

const DEFAULTS = {
  timezone: "Asia/Tokyo",
  postsPerDay: 1,
  postTimes: ["19:30"],
  // 同じ切り抜きを再利用するまでの最低日数。使い回しはスパム判定と飽きの両方に効く。
  clipCooldownDays: 14,
  hookCooldownDays: 7,
  video: {
    width: 1080,
    height: 1920,
    fps: 30,
    hookSeconds: 2.5,
    maxSeconds: 45,
    hookBg: "0x0E0E12",
    hookColor: "white",
    telopColor: "white",
    telopBox: "0x000000@0.45",
    fontFile: "", // 空なら ffmpeg の既定フォント。日本語は必ず実フォントを指定すること。
  },
  hashtags: ["#ライバー", "#切り抜き"],
  maxHashtags: 5,
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function mergeVideo(base, over) {
  return Object.assign({}, base, over || {})
}

/**
 * livers 設定を読み込み、運用ガードレールに照らして検証する。
 * ここで弾いたものは投稿計画に一切乗らない（= 事故の入口を塞ぐ）。
 */
function loadConfig(configPath, hooksPath) {
  const raw = readJson(configPath)
  const dir = path.dirname(path.resolve(configPath))
  const defaults = Object.assign({}, DEFAULTS, raw.defaults || {}, {
    video: mergeVideo(DEFAULTS.video, (raw.defaults || {}).video),
  })

  const hooksFile = hooksPath
    ? path.resolve(hooksPath)
    : path.resolve(dir, raw.hooksFile || "hooks.ja.json")
  const hooks = readJson(hooksFile).hooks

  const warnings = []
  const livers = []

  for (const liver of raw.livers || []) {
    const accounts = (liver.accounts || []).filter((a) => {
      if (!a.authorizedAt) {
        warnings.push(`${liver.id}: ${a.handle} は本人認可(authorizedAt)が無いため除外`)
        return false
      }
      if (!a.tokenEnv) {
        warnings.push(`${liver.id}: ${a.handle} は tokenEnv 未設定のため除外`)
        return false
      }
      return true
    })
    if (!accounts.length) {
      warnings.push(`${liver.id}: 投稿可能なアカウントが無いためスキップ`)
      continue
    }

    const clips = (liver.clips || []).filter((c) => {
      if (c.consent !== true) {
        warnings.push(`${liver.id}/${c.id}: 切り抜き利用の同意(consent)が無いため除外`)
        return false
      }
      const file = path.resolve(dir, c.file)
      if (!fs.existsSync(file)) {
        warnings.push(`${liver.id}/${c.id}: 素材が見つからない (${c.file})`)
        return false
      }
      return true
    })
    if (!clips.length) {
      warnings.push(`${liver.id}: 使用可能な素材が無いためスキップ`)
      continue
    }

    livers.push(
      Object.assign({}, liver, {
        accounts,
        clips: clips.map((c) => Object.assign({}, c, { path: path.resolve(dir, c.file) })),
        postTimes: liver.postTimes || defaults.postTimes,
        hashtags: (defaults.hashtags || []).concat(liver.hashtags || []),
        video: mergeVideo(defaults.video, liver.video),
      })
    )
  }

  return { org: raw.org || "", baseDir: dir, defaults, hooks, livers, warnings }
}

function loadState(stateFile) {
  try {
    return readJson(stateFile)
  }
  catch (e) {
    return { posts: [] }
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n")
}

module.exports = { DEFAULTS, loadConfig, loadState, saveState, readJson }
