"use strict"

const assert = require("assert")
const fs = require("fs")
const http = require("http")
const os = require("os")
const path = require("path")
const { test } = require("node:test")

const { publish } = require("../lib/publish")

/**
 * アップロード経路の検証。
 *
 * 実 API は叩けないので、同じ手順を喋るモックサーバを立てて実際に走らせる。
 * 「init で宣言したチャンク構成どおりに、全バイトが隙間なく届くか」は
 * 本物の API でなくても確かめられるし、ここを外すと本番で初めて壊れる。
 */
function mockTikTok(options) {
  const opts = options || {}
  const received = { init: null, chunks: [], bytes: Buffer.alloc(0), statusFetched: false }

  const server = http.createServer((req, res) => {
    const body = []
    req.on("data", (c) => body.push(c))
    req.on("end", () => {
      const buf = Buffer.concat(body)
      const json = (obj, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(obj))
      }

      if (req.url.includes("/video/init/")) {
        received.init = JSON.parse(buf.toString())
        received.authorization = req.headers.authorization
        return json({
          data: {
            publish_id: "pub_1",
            upload_url: `http://127.0.0.1:${server.address().port}/upload`,
          },
          error: { code: "ok" },
        })
      }
      if (req.url === "/upload") {
        if (opts.failChunk === received.chunks.length) {
          res.writeHead(500)
          return res.end("boom")
        }
        received.chunks.push(req.headers["content-range"])
        received.bytes = Buffer.concat([received.bytes, buf])
        res.writeHead(200)
        return res.end()
      }
      if (req.url.includes("/status/fetch/")) {
        received.statusFetched = true
        return json({ data: { status: "PROCESSING_UPLOAD" } })
      }
      res.writeHead(404)
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received }))
  })
}

/** publish は API のホストを定数で持つので、テストではモックへ差し替える。 */
function withMockedApi(port, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    const rewritten = String(url).replace("https://open.tiktokapis.com", `http://127.0.0.1:${port}`)
    return realFetch(rewritten, init)
  }
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = realFetch
  })
}

function makeVideo(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsw-up-"))
  const file = path.join(dir, "v.mp4")
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) buf[i] = i % 251
  fs.writeFileSync(file, buf)
  return { file, buf }
}

function entry(file) {
  return { id: "p1", handle: "@t", tokenEnv: "LSW_TEST_TOKEN", video: file, caption: "テスト" }
}

test("小さい動画は1チャンクで送り、全バイトがそのまま届く", async () => {
  const { server, received } = await mockTikTok()
  const { file, buf } = makeVideo(64 * 1024)
  process.env.LSW_ALLOW_PUBLISH = "1"
  process.env.LSW_TEST_TOKEN = "secret"

  const res = await withMockedApi(server.address().port, () =>
    publish(entry(file), { execute: true, mode: "inbox" })
  )
  server.close()

  assert.strictEqual(res.ok, true, res.error)
  assert.strictEqual(received.init.source_info.total_chunk_count, 1)
  assert.strictEqual(received.chunks.length, 1)
  assert.deepStrictEqual(received.chunks, [`bytes 0-${buf.length - 1}/${buf.length}`])
  assert.ok(received.bytes.equals(buf), "届いたバイト列が元の動画と一致しない")
  assert.strictEqual(received.statusFetched, true)
})

test("大きい動画は宣言どおり分割され、隙間も重複もなく全部届く", async () => {
  const { server, received } = await mockTikTok()
  // 64MB 超で分割経路に入る。中身の比較まで含めて 70MB を実際に流す。
  const size = 70 * 1024 * 1024
  const { file, buf } = makeVideo(size)
  process.env.LSW_ALLOW_PUBLISH = "1"
  process.env.LSW_TEST_TOKEN = "secret"

  const res = await withMockedApi(server.address().port, () =>
    publish(entry(file), { execute: true, mode: "inbox" })
  )
  server.close()

  assert.strictEqual(res.ok, true, res.error)
  const declared = received.init.source_info.total_chunk_count
  assert.ok(declared > 1, "分割されていない")
  assert.strictEqual(received.chunks.length, declared, "宣言したチャンク数と送信回数が違う")

  // Content-Range が 0 から始まり、隙間なく末尾まで連続していること
  let expectedStart = 0
  for (const range of received.chunks) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    assert.ok(m, `Content-Range の形式が不正: ${range}`)
    assert.strictEqual(Number(m[1]), expectedStart, `チャンクが連続していない: ${range}`)
    assert.strictEqual(Number(m[3]), size)
    expectedStart = Number(m[2]) + 1
  }
  assert.strictEqual(expectedStart, size, "最後のチャンクがファイル末尾に届いていない")
  assert.ok(received.bytes.equals(buf), "結合したバイト列が元の動画と一致しない")
})

test("途中のチャンクが失敗したら、そこで止めて理由を返す", async () => {
  const { server, received } = await mockTikTok({ failChunk: 2 })
  const { file } = makeVideo(70 * 1024 * 1024)
  process.env.LSW_ALLOW_PUBLISH = "1"
  process.env.LSW_TEST_TOKEN = "secret"

  const res = await withMockedApi(server.address().port, () =>
    publish(entry(file), { execute: true, mode: "inbox" })
  )
  server.close()

  assert.strictEqual(res.ok, false)
  assert.match(res.error, /チャンク 3\//)
  assert.strictEqual(res.publishId, "pub_1")
  assert.strictEqual(received.statusFetched, false, "失敗したのに status を取りに行っている")
})

test("トークンは Authorization ヘッダにだけ載る", async () => {
  const { server, received } = await mockTikTok()
  const { file } = makeVideo(1024)
  process.env.LSW_ALLOW_PUBLISH = "1"
  process.env.LSW_TEST_TOKEN = "secret-value"

  await withMockedApi(server.address().port, () =>
    publish(entry(file), { execute: true, mode: "inbox" })
  )
  server.close()

  assert.strictEqual(received.authorization, "Bearer secret-value")
  assert.ok(!JSON.stringify(received.init).includes("secret-value"), "本文にトークンが漏れている")
})
