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
  // 切り口テスト。同じ素材に複数のフックを当てて、どの切り口が刺さるかを測る。
  experiment: {
    enabled: false,
    maxVariants: 3,
    // バリエーション同士の間隔。短すぎると同じ素材が続けて出るので3日を下限にする。
    intervalDays: 3,
    // 勝ち負けを判定してよい最低ライン。これを割ったら「判定保留」。
    minPostsPerVariant: 2,
    minViewsPerVariant: 1000,
  },
  // AI生成素材レーン。本人が映らない補助映像（商品カット・背景・b-roll）を想定。
  ai: {
    disclosureText: "※この動画にはAI生成の映像が含まれます",
    disclosureTag: "#AI生成",
    // AI素材を含む投稿は本人の下書きに送る。直接公開はさせない。
    forceInbox: true,
    // 投稿APIに AIGC フラグを送るか。フィールド名は要検証なので既定は off。
    sendAigcFlag: false,
  },
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function mergeVideo(base, over) {
  return Object.assign({}, base, over || {})
}

/**
 * 素材ごとの同意チェック。
 *
 * 実写の切り抜きは本人の利用同意 (consent) が要る。
 * AI生成素材は本人が映らない前提なので consent は問わないが、
 * 本人の姿を生成する (depictsLiver) なら肖像の明示同意 (likenessConsent) が要る。
 * 何を生成したかを後から辿れるよう prompt の記録も必須にする。
 */
function checkClipConsent(liver, clip, warnings) {
  if (clip.source !== "ai") {
    if (clip.consent !== true) {
      warnings.push(`${liver.id}/${clip.id}: 切り抜き利用の同意(consent)が無いため除外`)
      return false
    }
    return true
  }
  if (!clip.prompt) {
    warnings.push(`${liver.id}/${clip.id}: AI素材に生成プロンプトの記録が無いため除外`)
    return false
  }
  if (clip.depictsLiver === true && clip.likenessConsent !== true) {
    warnings.push(
      `${liver.id}/${clip.id}: 本人の姿を生成するAI素材に肖像の明示同意(likenessConsent)が無いため除外`
    )
    return false
  }
  return true
}

/** 1本の素材の中の「見せどころ」。切り口テストではここも変える。 */
function normalizeSegments(clip) {
  const list = (clip.segments || []).filter((s) => s && s.id)
  if (list.length) return list
  return [
    {
      id: `${clip.id}-full`,
      start: clip.highlightAt || 0,
      telop: clip.telop || "",
      topic: clip.topic || "",
    },
  ]
}

/**
 * livers 設定を読み込み、運用ガードレールに照らして検証する。
 * ここで弾いたものは投稿計画に一切乗らない（= 事故の入口を塞ぐ）。
 */
function loadConfig(configPath, hooksPath) {
  const raw = readJson(configPath)
  const dir = path.dirname(path.resolve(configPath))
  const rawDefaults = raw.defaults || {}
  const defaults = Object.assign({}, DEFAULTS, rawDefaults, {
    video: mergeVideo(DEFAULTS.video, rawDefaults.video),
    experiment: mergeVideo(DEFAULTS.experiment, rawDefaults.experiment),
    ai: mergeVideo(DEFAULTS.ai, rawDefaults.ai),
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

    // 生成待ちの AI 素材は投稿計画には乗せず、プロンプト出力の対象としてだけ持つ。
    const pendingClips = (liver.clips || []).filter(
      (c) => c.source === "ai" && c.pending === true
    )

    const clips = (liver.clips || []).filter((c) => {
      if (c.pending === true) return false
      if (!checkClipConsent(liver, c, warnings)) return false
      const file = path.resolve(dir, c.file || "")
      if (!c.file || !fs.existsSync(file)) {
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
        clips: clips.map((c) =>
          Object.assign({}, c, {
            source: c.source || "clip",
            path: path.resolve(dir, c.file),
            segments: normalizeSegments(c),
          })
        ),
        pendingClips,
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

module.exports = { DEFAULTS, loadConfig, loadState, saveState, readJson, normalizeSegments }
