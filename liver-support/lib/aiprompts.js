"use strict"

const { template } = require("./util")

/**
 * AI生成素材レーンのプロンプト組み立て。
 *
 * 投稿の元ネタでは「1つのプロンプトで作れる」ことが強調されていたが、
 * 運用で効くのはプロンプトの巧さより「何を生成したかが後から辿れること」。
 * 生成物には必ず prompt / model / depictsLiver を記録して登録する（lib/config.js が検証する）。
 *
 * 本人の顔を生成する用途はこのレーンの対象外。
 * やるなら肖像の明示同意 (likenessConsent) を取ったうえで、素材側にその記録を残すこと。
 */
function buildPrompt(spec, tpl, constraints) {
  const vars = {
    subject: spec.subject || "",
    place: spec.place || "室内",
    action: spec.action || "",
    product: spec.product || "",
    mood: spec.mood || "落ち着いた",
    seconds: spec.seconds || 5,
  }
  const body = template(tpl.template, vars).trim()
  return [body].concat((constraints || []).map((c) => `- ${c}`)).join("\n")
}

/** 1つの用途から、切り口違いのプロンプトを n 本作る。 */
function promptVariations(spec, templates, constraints, n) {
  const list = spec.templateId
    ? templates.filter((t) => t.id === spec.templateId)
    : templates
  const out = []
  for (let i = 0; i < (n || 1) && i < list.length; i++) {
    const tpl = list[i]
    out.push({
      templateId: tpl.id,
      name: tpl.name,
      use: tpl.use,
      prompt: buildPrompt(spec, tpl, constraints),
    })
  }
  return out
}

/** 生成待ちの素材を、そのまま渡せるプロンプト表にする。 */
function promptSheet(config, aiPrompts, options) {
  const opts = options || {}
  const sheets = []
  for (const liver of config.livers) {
    if (opts.liverId && liver.id !== opts.liverId) continue
    const pending = liver.pendingClips || []
    const specs = pending.length
      ? pending.map((c) => Object.assign({ id: c.id }, c.spec || {}, { templateId: c.templateId }))
      : []
    for (const spec of specs) {
      sheets.push({
        liverId: liver.id,
        liverName: liver.name,
        clipId: spec.id,
        variations: promptVariations(
          spec,
          aiPrompts.templates,
          aiPrompts.constraints,
          opts.count || 1
        ),
      })
    }
  }
  return sheets
}

function toMarkdown(sheets) {
  const lines = ["# AI生成素材のプロンプト", ""]
  if (!sheets.length) {
    lines.push("生成待ちの素材がない（config の clips に source:\"ai\", pending:true を追加すると出る）。")
    return lines.join("\n") + "\n"
  }
  for (const sheet of sheets) {
    lines.push(`## ${sheet.liverName} / ${sheet.clipId}`, "")
    for (const v of sheet.variations) {
      lines.push(`### ${v.name}（${v.use}）`, "", "```", v.prompt, "```", "")
    }
    lines.push(
      "生成後に登録すること: `prompt`（実際に使った文面）・`model`・`depictsLiver`・`file`。",
      "本人の姿を生成した場合は `likenessConsent: true` が無いと計画に乗らない。",
      ""
    )
  }
  return lines.join("\n") + "\n"
}

module.exports = { buildPrompt, promptVariations, promptSheet, toMarkdown }
