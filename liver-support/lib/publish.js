"use strict"

const fs = require("fs")

/**
 * TikTok Content Posting API アダプタ。
 *
 * 既定は inbox（アプリ内の下書きに送り、ライバー本人が中身を確認して公開）。
 * direct（即時公開）は audited scope が要るうえ、事故ったときに取り返しがつかないので明示指定のみ。
 *
 * 実行には 2つの条件を両方満たす必要がある:
 *   - --execute
 *   - 環境変数 LSW_ALLOW_PUBLISH=1
 * トークンはアカウントごとの環境変数（tokenEnv）からのみ読み、ログには出さない。
 */

const API = "https://open.tiktokapis.com/v2"
const CHUNK = 10 * 1024 * 1024

function initEndpoint(mode) {
  return mode === "direct"
    ? `${API}/post/publish/video/init/`
    : `${API}/post/publish/inbox/video/init/`
}

function initBody(entry, size, mode, opts) {
  const source_info = {
    source: "FILE_UPLOAD",
    video_size: size,
    chunk_size: Math.min(size, CHUNK),
    total_chunk_count: Math.max(1, Math.ceil(size / CHUNK)),
  }
  if (mode !== "direct") return { source_info }
  const post_info = {
    title: entry.caption,
    privacy_level: entry.privacyLevel || "SELF_ONLY",
    disable_duet: false,
    disable_comment: false,
    disable_stitch: false,
  }
  // AIGC ラベルのフィールド名は API 側で変わりうるので、送るかどうかは設定で切る。
  // 送らない場合もキャプション側の開示は必ず入っている（lib/caption.js）。
  if (entry.containsAi && opts && opts.sendAigcFlag) post_info.is_aigc = true
  return { post_info, source_info }
}

/**
 * AI生成素材を含む投稿の直接公開を止める。
 * 開示が要る投稿ほど、本人が中身を見てから出すべきなので既定は下書き固定。
 */
function aiGuard(entry, mode, ai) {
  if (!entry.containsAi) return null
  if (mode === "direct" && (!ai || ai.forceInbox !== false)) {
    return "AI生成素材を含む投稿の直接公開は既定で禁止（ai.forceInbox を false にするか inbox で送ること）"
  }
  return null
}

function describe(entry, mode, ai) {
  const size = fs.existsSync(entry.video) ? fs.statSync(entry.video).size : null
  return {
    id: entry.id,
    handle: entry.handle,
    mode,
    tokenEnv: entry.tokenEnv,
    tokenPresent: Boolean(process.env[entry.tokenEnv]),
    video: entry.video,
    videoSize: size,
    containsAi: Boolean(entry.containsAi),
    blocked: aiGuard(entry, mode, ai),
    steps: [
      `POST ${initEndpoint(mode)}`,
      "PUT <upload_url>  (Content-Range / video/mp4)",
      `POST ${API}/post/publish/status/fetch/`,
    ],
    body: size === null ? null : initBody(entry, size, mode, ai),
  }
}

async function publish(entry, opts) {
  const mode = (opts && opts.mode) || "inbox"
  const ai = (opts && opts.ai) || {}
  if (!opts || !opts.execute) return { ok: true, dryRun: true, plan: describe(entry, mode, ai) }
  const blocked = aiGuard(entry, mode, ai)
  if (blocked) return { ok: false, error: blocked }
  if (process.env.LSW_ALLOW_PUBLISH !== "1") {
    return { ok: false, error: "LSW_ALLOW_PUBLISH=1 が未設定のため実行しない" }
  }
  const token = process.env[entry.tokenEnv]
  if (!token) return { ok: false, error: `${entry.tokenEnv} が未設定` }
  if (!fs.existsSync(entry.video)) return { ok: false, error: `動画が無い: ${entry.video}` }

  const size = fs.statSync(entry.video).size
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
  }
  const initRes = await fetch(initEndpoint(mode), {
    method: "POST",
    headers,
    body: JSON.stringify(initBody(entry, size, mode, ai)),
  })
  const init = await initRes.json()
  if (!initRes.ok || (init.error && init.error.code !== "ok")) {
    return { ok: false, error: `init 失敗: ${JSON.stringify(init.error || init)}` }
  }

  const { publish_id, upload_url } = init.data
  const buf = fs.readFileSync(entry.video)
  const uploadRes = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Content-Range": `bytes 0-${size - 1}/${size}`,
    },
    body: buf,
  })
  if (!uploadRes.ok) {
    return { ok: false, error: `upload 失敗: HTTP ${uploadRes.status}`, publishId: publish_id }
  }

  const statusRes = await fetch(`${API}/post/publish/status/fetch/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ publish_id }),
  })
  const status = await statusRes.json()
  return { ok: true, publishId: publish_id, status: status.data || status }
}

module.exports = { publish, describe, initBody, initEndpoint, aiGuard }
