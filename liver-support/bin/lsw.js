#!/usr/bin/env node
"use strict"

/**
 * lsw — liver support workflow
 *
 *   plan    素材 × フック × 投稿枠 を割り当てて投稿計画を作る
 *   prompts AI生成素材レーンのプロンプト表を出す
 *   build   計画から動画を組み立てる（既定は dry-run: ffmpeg コマンドを出すだけ）
 *   queue   計画を投稿キュー(JSONL)に変換する
 *   publish キューの予約時刻を過ぎたものを投稿する（既定は dry-run）
 *   report  投稿結果 CSV をフック型別に集計する
 *   doctor  設定と実行環境を点検する
 */

const fs = require("fs")
const path = require("path")
const { loadConfig, loadState, saveState, readJson } = require("../lib/config")
const { buildPlan } = require("../lib/plan")
const { renderCommand, hasFfmpeg, toShell, execute, writeTextFiles } = require("../lib/render")
const { toQueue, writeQueue, readQueue, due } = require("../lib/queue")
const { publish } = require("../lib/publish")
const { report } = require("../lib/report")
const { promptSheet, toMarkdown } = require("../lib/aiprompts")

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=")
      if (v !== undefined) args[k] = v
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[k] = argv[++i]
      else args[k] = true
    }
    else args._.push(a)
  }
  return args
}

const args = parseArgs(process.argv.slice(3))
const cmd = process.argv[2]
const root = path.resolve(__dirname, "..")
const configPath = path.resolve(args.config || path.join(root, "config/livers.json"))
const statePath = path.resolve(args.state || path.join(root, "state/history.json"))
const outDir = path.resolve(args.out || path.join(root, "build"))

function needConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(`設定が見つからない: ${configPath}`)
    console.error("config/livers.example.json をコピーして作成すること。")
    process.exit(1)
  }
  const config = loadConfig(configPath, args.hooks)
  for (const w of config.warnings) console.error(`[warn] ${w}`)
  return config
}

function planFile() {
  return path.resolve(args.plan || path.join(outDir, "plan.json"))
}

function queueFile() {
  return path.resolve(args.queue || path.join(outDir, "queue.jsonl"))
}

const commands = {
  plan() {
    const config = needConfig()
    const plan = buildPlan(config, {
      days: Number(args.days || 7),
      startDate: args.start || null,
      seed: args.seed || "lsw",
      experiment: args.experiment === undefined ? undefined : args.experiment !== "false",
      state: loadState(statePath),
      outDir,
    })
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(planFile(), JSON.stringify(plan, null, 2) + "\n")
    console.log(`投稿計画 ${plan.posts.length}本 → ${planFile()}`)
    for (const p of plan.posts) {
      const marks = [
        p.variantId ? `テスト${p.variantId}/${p.variants}` : null,
        p.containsAi ? "AI素材" : null,
      ].filter(Boolean)
      console.log(
        `  ${p.publishAt}  ${p.handle}  [${p.hookType}] ${p.hookText}  (${p.clipId}` +
          `${p.segmentId && p.segmentId !== p.clipId + "-full" ? "/" + p.segmentId : ""})` +
          (marks.length ? `  ${marks.join(" ")}` : "")
      )
    }
    const running = plan.posts.filter((p) => p.experimentId)
    if (running.length) {
      const ids = [...new Set(running.map((p) => p.experimentId))]
      console.log(`  切り口テスト ${ids.length}件 / 投稿 ${running.length}本: ${ids.join(", ")}`)
    }
    for (const s of plan.skipped) console.log(`  [skip] ${s.date} ${s.liverId}: ${s.reason}`)
    if (args.commit) {
      const state = loadState(statePath)
      state.posts = state.posts.concat(
        plan.posts.map((p) => ({
          id: p.id,
          date: p.date,
          publishAt: p.publishAt,
          liverId: p.liverId,
          clipId: p.clipId,
          segmentId: p.segmentId,
          hookId: p.hookId,
          hookText: p.hookText,
          experimentId: p.experimentId,
          variantId: p.variantId,
        }))
      )
      saveState(statePath, state)
      console.log(`履歴を更新 → ${statePath}`)
    }
  },

  build() {
    const plan = readJson(planFile())
    const doExecute = Boolean(args.execute)
    if (doExecute && !hasFfmpeg()) {
      console.error("ffmpeg が見つからない。--execute を外すか ffmpeg を入れること。")
      process.exit(1)
    }
    const script = []
    let ok = 0
    for (const post of plan.posts) {
      const cmdSpec = renderCommand(post, { cwd: root })
      if (doExecute) {
        process.stdout.write(`build ${post.id} … `)
        const done = execute(cmdSpec)
        console.log(done ? "ok" : "失敗")
        if (done) ok++
      }
      else {
        writeTextFiles(cmdSpec)
        script.push(`# ${post.id}  [${post.hookType}] ${post.hookText}`)
        script.push(toShell(cmdSpec), "")
      }
    }
    if (doExecute) console.log(`${ok}/${plan.posts.length} 本を出力`)
    else {
      const file = path.join(outDir, "build.sh")
      fs.writeFileSync(file, "#!/bin/sh\nset -e\n\n" + script.join("\n"))
      fs.chmodSync(file, 0o755)
      console.log(`dry-run: ${plan.posts.length}本分の ffmpeg コマンド → ${file}`)
    }
  },

  queue() {
    const plan = readJson(planFile())
    const entries = toQueue(plan)
    writeQueue(queueFile(), entries)
    console.log(`投稿キュー ${entries.length}件 → ${queueFile()}`)
  },

  async publish() {
    const entries = readQueue(queueFile())
    const target = args.all ? entries.filter((e) => e.status === "pending") : due(entries, args.now)
    const mode = args.mode || "inbox"
    const ai = fs.existsSync(configPath) ? loadConfig(configPath, args.hooks).defaults.ai : undefined
    if (!target.length) {
      console.log("投稿対象なし（予約時刻前、または全て処理済み）")
      return
    }
    for (const entry of target) {
      const res = await publish(entry, { execute: Boolean(args.execute), mode, ai })
      if (res.dryRun) {
        console.log(`[dry-run] ${entry.id} → ${entry.handle} (${mode})`)
        console.log(`  token(${res.plan.tokenEnv}): ${res.plan.tokenPresent ? "あり" : "なし"}`)
        console.log(`  video: ${res.plan.video} ${res.plan.videoSize === null ? "(未生成)" : res.plan.videoSize + "B"}`)
        if (res.plan.containsAi) console.log("  AI生成素材を含む（キャプションに開示あり）")
        if (res.plan.blocked) console.log(`  [block] ${res.plan.blocked}`)
        res.plan.steps.forEach((s) => console.log(`  ${s}`))
        continue
      }
      if (res.ok) {
        entry.status = mode === "direct" ? "published" : "inbox"
        entry.publishId = res.publishId
        console.log(`${entry.id} → ${entry.handle}: ${entry.status} (${res.publishId})`)
      }
      else {
        entry.status = "failed"
        entry.error = res.error
        console.error(`${entry.id} → ${entry.handle}: 失敗 ${res.error}`)
      }
    }
    if (args.execute) writeQueue(queueFile(), entries)
  },

  report() {
    const metricsFile = path.resolve(args.metrics || path.join(root, "config/metrics.example.csv"))
    const thresholds = fs.existsSync(configPath)
      ? loadConfig(configPath, args.hooks).defaults.experiment
      : undefined
    const r = report(metricsFile, readQueue(queueFile()), { experiment: thresholds })
    const table = (rows) =>
      rows.forEach((x) =>
        console.log(
          `  ${String(x.key).padEnd(14)} 本数${String(x.posts).padStart(3)}  ` +
            `3秒維持 ${(x.retention3s * 100).toFixed(1)}%  再生 ${String(x.views).padStart(6)}  ` +
            `プロフ遷移 ${x.ctr}%  フォロー ${x.follows}`
        )
      )
    console.log(`集計対象 ${r.total}件`)
    console.log("\nフック型別（3秒維持率順 = 冒頭の強さ）")
    table(r.byHookType)
    console.log("\nフック文別")
    table(r.byHook)
    console.log("\nライバー別")
    table(r.byLiver)

    if (r.experiments.length) {
      console.log("\n切り口テスト")
      for (const e of r.experiments) {
        console.log(`  ${e.id}`)
        for (const v of e.variants) {
          console.log(
            `    [${v.hookType}] ${v.hookId}  本数${v.posts}  ` +
              `3秒維持 ${(v.retention3s * 100).toFixed(1)}%  再生 ${v.views}` +
              (v.qualified ? "" : "  ※判定対象外")
          )
        }
        console.log(
          e.decided
            ? `    → 勝ち: ${e.winner.hookId} [${e.winner.hookType}]。この型を増やし、下位の型は外す`
            : `    → 判定保留: ${e.reason}` +
              (e.leading ? `（現時点の先行は ${e.leading.hookId}）` : "")
        )
      }
    }
  },

  prompts() {
    const config = needConfig()
    const aiPrompts = readJson(path.resolve(args.prompts || path.join(root, "config/ai-prompts.ja.json")))
    const sheets = promptSheet(config, aiPrompts, {
      liverId: args.liver,
      count: Number(args.count || 1),
    })
    const md = toMarkdown(sheets)
    fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, "prompts.md")
    fs.writeFileSync(file, md)
    console.log(md)
    console.log(`→ ${file}`)
  },

  doctor() {
    const config = needConfig()
    console.log(`ライバー ${config.livers.length}名 / フック ${config.hooks.length}型`)
    for (const l of config.livers) {
      const tokens = l.accounts.map(
        (a) => `${a.handle}:${process.env[a.tokenEnv] ? "token有" : "token無"}`
      )
      console.log(`  ${l.id} 素材${l.clips.length}本 ${tokens.join(" ")}`)
      const perDay = Math.min(l.postTimes.length, l.postsPerDay || config.defaults.postsPerDay)
      const needed = config.defaults.clipCooldownDays * perDay
      if (l.clips.length < needed) {
        console.log(
          `    [warn] 素材が${l.clips.length}本。クールダウン${config.defaults.clipCooldownDays}日 × ` +
            `1日${perDay}本なら${needed}本必要（不足分は投稿枠が空く）`
        )
      }
      const aiClips = l.clips.filter((c) => c.source === "ai")
      if (aiClips.length) console.log(`    AI生成素材 ${aiClips.length}本（キャプションに開示が入る）`)
      if ((l.pendingClips || []).length) {
        console.log(`    生成待ち ${l.pendingClips.length}本（lsw prompts でプロンプトを出す）`)
      }
      const segs = l.clips.filter((c) => c.segments.length > 1).length
      if (config.defaults.experiment.enabled && !segs) {
        console.log("    [warn] segments を持つ素材が無い。切り口テストはフック違いだけになる")
      }
    }
    const exp = config.defaults.experiment
    console.log(
      `切り口テスト: ${exp.enabled ? "有効" : "無効"}（最大${exp.maxVariants}本 / ${exp.intervalDays}日間隔 / ` +
        `判定は各${exp.minPostsPerVariant}本・${exp.minViewsPerVariant}再生から）`
    )
    console.log(`ffmpeg: ${hasFfmpeg() ? "あり" : "なし（build は dry-run のみ）"}`)
    if (!config.defaults.video.fontFile) {
      console.log("[warn] video.fontFile 未設定。日本語テロップが豆腐になるので日本語フォントを指定すること。")
    }
    console.log(`公開実行: ${process.env.LSW_ALLOW_PUBLISH === "1" ? "許可" : "禁止(既定)"}`)
  },
}

if (!cmd || !commands[cmd]) {
  console.log(fs.readFileSync(path.join(root, "docs/usage.txt"), "utf8"))
  process.exit(cmd ? 1 : 0)
}

Promise.resolve(commands[cmd]()).catch((e) => {
  console.error(e.message)
  process.exit(1)
})
