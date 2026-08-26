"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

/** 素材ファイルの実在チェックがあるので、テスト用にダミーの mp4 を置く。 */
function makeWorkspace(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsw-"))
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true })
  const clip = (id) => {
    const file = path.join("assets", `${id}.mp4`)
    fs.writeFileSync(path.join(dir, file), "dummy")
    return file
  }

  const config = Object.assign(
    {
      org: "テスト事務所",
      hooksFile: path.resolve(__dirname, "../config/hooks.ja.json"),
      defaults: {
        postTimes: ["19:30"],
        clipCooldownDays: 3,
        hookCooldownDays: 2,
        video: { fontFile: "" },
      },
      livers: [
        {
          id: "hina",
          name: "ひな",
          genre: "雑談",
          streamTime: "毎晩21時",
          accounts: [
            {
              platform: "tiktok",
              handle: "@hina_live",
              tokenEnv: "TIKTOK_TOKEN_HINA",
              authorizedAt: "2026-08-01",
            },
          ],
          clips: [
            { id: "c1", file: clip("c1"), title: "切り抜き1", topic: "読み間違い", tags: ["雑談"], consent: true },
            { id: "c2", file: clip("c2"), title: "切り抜き2", topic: "神対応", tags: ["雑談"], consent: true },
            { id: "c3", file: clip("c3"), title: "切り抜き3", topic: "ハプニング", tags: ["雑談"], consent: true },
          ],
        },
      ],
    },
    overrides || {}
  )

  const configPath = path.join(dir, "livers.json")
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  return { dir, configPath, config }
}

module.exports = { makeWorkspace }
