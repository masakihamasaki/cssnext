/**
 * Skills API: publish a team procedure once, pin the version, run it.
 *
 *   node --experimental-strip-types examples/02-skills.ts [stylesheet.css]
 *
 * Uploads skills/css-modernizer as a Skill, prints the version id it resolved
 * to, then runs a Messages request that loads that exact version alongside
 * Anthropic's built-in `docx` skill and produces a report.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { client, MODEL, CODE_EXECUTION_TOOL } from "../src/client.ts"
import {
  downloadFile,
  fileBlock,
  generatedFileIds,
  uploadFileOnce,
} from "../src/files.ts"
import { log } from "../src/log.ts"
import { containerSkills, readSkillFrontmatter, upsertSkill } from "../src/skills.ts"

const ROOT = join(import.meta.dirname, "..")
const OUT = join(ROOT, "out")
const SKILL_DIR = join(ROOT, "skills", "css-modernizer")

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })

  const frontmatter = await readSkillFrontmatter(SKILL_DIR)
  log.step(`Publishing skill "${frontmatter.name}"`)

  // First run creates the skill; every run after adds an immutable version.
  const { skill, versionId, created } = await upsertSkill(SKILL_DIR, "CSS modernizer")
  log.detail(`${created ? "created" : "new version of"} ${skill.id}`)
  log.detail(`pinned version: ${versionId}`)

  const stylesheet = process.argv[2] ?? (await writeSampleStylesheet())
  const uploaded = await uploadFileOnce(stylesheet, join(OUT, "file-index.json"), {
    mimeType: "text/plain",
  })
  log.detail(`stylesheet uploaded as ${uploaded.id}`)

  log.step("Running the skill")
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    container: {
      // Pin the concrete version id rather than "latest": a procedure that has
      // been reviewed should keep behaving the way it was reviewed. Swap to
      // "latest" only while iterating on the skill itself.
      skills: containerSkills([
        { id: skill.id, version: versionId },
        { id: "docx", version: "latest", anthropic: true },
      ]),
    },
    // Skills run inside the container, so the code execution tool must be
    // declared or none of them can do anything.
    tools: [CODE_EXECUTION_TOOL],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Audit the attached stylesheet with the css-modernizer skill, " +
              "then save the report as css-report.docx.",
          },
          fileBlock(uploaded, true),
        ],
      },
    ],
  })

  for (const block of response.content) {
    if (block.type === "text") log.say(block.text)
  }

  // The response reports which skills actually got loaded, and at which
  // resolved versions -- useful to log next to the run.
  for (const loaded of response.container?.skills ?? []) {
    log.detail(`loaded ${loaded.type} skill ${loaded.skill_id} @ ${loaded.version}`)
  }

  for (const fileId of generatedFileIds(response)) {
    const metadata = await client.files.retrieveMetadata(fileId)
    const path = join(OUT, metadata.filename)
    await downloadFile(fileId, path)
    log.say(`downloaded ${path}`)
  }
}

async function writeSampleStylesheet(): Promise<string> {
  const path = join(OUT, "sample.css")
  await writeFile(
    path,
    `:root { --brand: #b3d; --space: 1rem; }
.card { color: var(--brand); padding: var(--space); overflow-wrap: break-word; }
.card:matches(.is-wide, .is-tall) { filter: blur(2px); }
@media (width >= 40rem) { .card { padding: 2rem; } }
`
  )
  return path
}

await main()
