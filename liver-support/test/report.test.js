"use strict"

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { test } = require("node:test")

const { report, parseCsv } = require("../lib/report")

const QUEUE = [
  { id: "p1", liverId: "hina", hookId: "kyokan-01", hookType: "共感" },
  { id: "p2", liverId: "hina", hookId: "igai-01", hookType: "意外性" },
  { id: "p3", liverId: "ren", hookId: "igai-01", hookType: "意外性" },
]

test("CSV を数値として読む", () => {
  const rows = parseCsv("post_id,views,retention3s\np1,100,0.5\n")
  assert.deepStrictEqual(rows, [{ post_id: "p1", views: 100, retention3s: 0.5 }])
})

test("フック型別に3秒維持率の高い順で並ぶ", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lsw-r-")), "m.csv")
  fs.writeFileSync(
    file,
    [
      "post_id,views,retention3s,profile_views,follows,gifts",
      "p1,1000,0.30,10,1,0",
      "p2,2000,0.70,200,20,2",
      "p3,1000,0.60,100,10,1",
      "unknown,999,0.99,999,99,9",
    ].join("\n")
  )
  const r = report(file, QUEUE)
  assert.strictEqual(r.total, 4)
  assert.strictEqual(r.byHookType[0].key, "意外性")
  assert.strictEqual(r.byHookType[0].posts, 2)
  assert.strictEqual(r.byHookType[0].retention3s, 0.65)
  assert.strictEqual(r.byHookType[1].key, "共感")
  // キューに無い post_id は集計に混ぜない
  assert.strictEqual(r.byLiver.reduce((n, x) => n + x.posts, 0), 3)
})

test("プロフィール遷移率を % で出す", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lsw-r-")), "m.csv")
  fs.writeFileSync(file, "post_id,views,retention3s,profile_views,follows\np1,1000,0.5,50,5\n")
  const r = report(file, QUEUE)
  assert.strictEqual(r.byHookType[0].ctr, 5)
})
