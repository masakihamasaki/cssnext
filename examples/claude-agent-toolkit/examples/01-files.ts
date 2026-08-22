/**
 * Files API: upload once, reference many times, download what came back.
 *
 *   node --experimental-strip-types examples/01-files.ts [stylesheet.css]
 *
 * Uploads a stylesheet, asks two separate questions about it without ever
 * re-sending the bytes, then has the code execution tool produce a file and
 * pulls that file back down.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { client, MODEL, CODE_EXECUTION_TOOL } from "../src/client.ts"
import {
  downloadFile,
  fileBlock,
  generatedFileIds,
  listAllFiles,
  uploadFileOnce,
} from "../src/files.ts"
import { log } from "../src/log.ts"

const OUT = join(import.meta.dirname, "..", "out")

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })

  const source = process.argv[2] ?? (await writeSampleStylesheet())

  log.step(`Uploading ${source}`)
  const uploaded = await uploadFileOnce(
    source,
    join(OUT, "file-index.json"),
    // Text has to be declared as text/plain to be usable in a document block.
    { mimeType: "text/plain", expiresInSeconds: 60 * 60 * 24 }
  )
  log.detail(
    `${uploaded.id} (${uploaded.size_bytes} bytes, expires ${uploaded.expires_at ?? "never"})`
  )

  // Two questions, one upload. The file_id is what travels, not the bytes.
  for (const question of [
    "List every custom property this stylesheet declares.",
    "Which declarations in this stylesheet would need a fallback for a browser without custom property support?",
  ]) {
    log.step(question)
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            fileBlock(uploaded),
          ],
        },
      ],
    })
    for (const block of response.content) {
      if (block.type === "text") log.say(block.text)
    }
  }

  // The same file, handed to the sandbox instead of read as a document. A
  // container_upload block is how bytes reach the code execution tool.
  log.step("Asking the code execution tool to chart the findings")
  const analysis = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    tools: [CODE_EXECUTION_TOOL],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Count how many times each CSS property appears in the attached stylesheet, " +
              "then save a horizontal bar chart of the top properties as chart.png.",
          },
          fileBlock(uploaded, true),
        ],
      },
    ],
  })

  const produced = generatedFileIds(analysis)
  log.detail(`${produced.length} file(s) produced in the container`)

  // Only files created by a skill or the code execution tool are downloadable;
  // downloading one you uploaded yourself is a 400.
  for (const fileId of produced) {
    const metadata = await client.files.retrieveMetadata(fileId)
    const path = join(OUT, metadata.filename)
    await downloadFile(fileId, path)
    log.say(`downloaded ${path}`)
  }

  const all = await listAllFiles()
  log.detail(`workspace now holds ${all.length} file(s)`)
}

async function writeSampleStylesheet(): Promise<string> {
  const path = join(OUT, "sample.css")
  await writeFile(
    path,
    `:root {
  --brand: #b3d;
  --space: 1rem;
  --font: system-ui, sans-serif;
}

@custom-media --wide (width >= 40rem);

.card {
  color: var(--brand);
  padding: var(--space);
  font-family: var(--font);
  overflow-wrap: break-word;
}

.card:not(.is-flat, .is-bare) {
  filter: drop-shadow(0 1px 2px gray(0, 20%));
}

@media (--wide) {
  .card { padding: calc(var(--space) * 2); }
}
`
  )
  return path
}

await main()
