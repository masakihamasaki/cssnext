import { createReadStream } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, posix, relative, sep } from "node:path"

import Anthropic, { toFile, type Uploadable } from "@anthropic-ai/sdk"
import type { SkillVersion } from "@anthropic-ai/sdk/resources/skills/versions"

import { client } from "./client.ts"
import { mimeTypeFor } from "./files.ts"

/**
 * A Skill is a folder with a `SKILL.md` at its root plus whatever scripts and
 * references that document tells Claude to use. Uploading it returns a
 * `skill_id`, and every upload after that creates a new immutable *version*.
 *
 * That immutability is the operational point: a request pins
 * `{skill_id, version}`, so a procedure that has been reviewed keeps behaving
 * the way it was reviewed. `"latest"` is a convenience for development; pin a
 * concrete `skver_...` id in anything you would not want to change underneath
 * you.
 */

export interface SkillFrontmatter {
  name: string
  description: string
}

/**
 * Read and check the `SKILL.md` frontmatter before uploading, so a typo fails
 * locally rather than as a 400 halfway through a multipart upload.
 */
export async function readSkillFrontmatter(
  directory: string
): Promise<SkillFrontmatter> {
  const source = await readFile(join(directory, "SKILL.md"), "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!match) {
    throw new Error(`${directory}/SKILL.md has no YAML frontmatter block.`)
  }

  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
    if (pair) fields[pair[1]!] = pair[2]!.replace(/^["']|["']$/g, "")
  }

  const name = fields.name
  const description = fields.description
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error(
      `SKILL.md "name" must be 1-64 characters of lowercase letters, numbers and hyphens (got ${JSON.stringify(name)}).`
    )
  }
  if (!description || description.length > 1024) {
    throw new Error(`SKILL.md "description" must be non-empty and at most 1024 characters.`)
  }
  return { name, description }
}

/**
 * Collect a skill directory into the multipart upload the API expects.
 *
 * Every file must be sent under the same top-level directory, and `SKILL.md`
 * must sit at that directory's root — the filename carries the path, so
 * `financial_skill/analyze.py` is what identifies the file, not the local path
 * it happens to live at.
 */
async function skillFiles(directory: string): Promise<Uploadable[]> {
  const root = basename(directory)
  const uploads: Uploadable[] = []

  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const relativePath = relative(directory, path).split(sep).join(posix.sep)
      uploads.push(
        await toFile(createReadStream(path), posix.join(root, relativePath), {
          type: mimeTypeFor(path),
        })
      )
    }
  }

  await stat(join(directory, "SKILL.md")).catch(() => {
    throw new Error(`${directory} has no SKILL.md at its root.`)
  })
  await walk(directory)
  return uploads
}

/** Create a brand-new skill from a directory. Returns the skill and its first version. */
export async function createSkill(
  directory: string,
  displayName?: string
): Promise<Anthropic.Skill> {
  await readSkillFrontmatter(directory)
  return client.skills.create({
    files: await skillFiles(directory),
    ...(displayName ? { display_name: displayName } : {}),
  })
}

/** Publish a new immutable version of an existing skill. */
export async function publishSkillVersion(
  skillId: string,
  directory: string
): Promise<SkillVersion> {
  await readSkillFrontmatter(directory)
  return client.skills.versions.create(skillId, {
    files: await skillFiles(directory),
  })
}

/**
 * Create the skill on first run and add a version on every run after that, so
 * a deploy script is idempotent. Matching is by `display_name`, which is the
 * only stable human-facing handle a skill has.
 */
export async function upsertSkill(
  directory: string,
  displayName: string
): Promise<{ skill: Anthropic.Skill; versionId: string; created: boolean }> {
  const existing = await findSkillByDisplayName(displayName)
  if (!existing) {
    const skill = await createSkill(directory, displayName)
    return { skill, versionId: skill.latest_version_id, created: true }
  }
  const version = await publishSkillVersion(existing.id, directory)
  return { skill: existing, versionId: version.id, created: false }
}

export async function findSkillByDisplayName(
  displayName: string
): Promise<Anthropic.Skill | undefined> {
  for await (const skill of client.skills.list({ source: "custom", limit: 100 })) {
    if (skill.display_name === displayName) return skill
  }
  return undefined
}

export async function listSkills(
  source?: "custom" | "anthropic"
): Promise<Anthropic.Skill[]> {
  const skills: Anthropic.Skill[] = []
  for await (const skill of client.skills.list({
    ...(source ? { source } : {}),
    limit: 100,
  })) {
    skills.push(skill)
  }
  return skills
}

/**
 * Build the `container.skills` array for a Messages request.
 *
 * Anthropic's own skills use short ids (`pptx`, `xlsx`, `docx`, `pdf`) with a
 * date version; custom skills use `skill_...` with a `skver_...` version. At
 * most 20 skills per request, and the code execution tool has to be declared
 * for any of them to run.
 */
export function containerSkills(
  entries: Array<{ id: string; version?: string; anthropic?: boolean }>
): Anthropic.SkillParams[] {
  if (entries.length > 20) {
    throw new Error("A request may load at most 20 skills.")
  }
  return entries.map((entry) => ({
    type: entry.anthropic ? "anthropic" : "custom",
    skill_id: entry.id,
    version: entry.version ?? "latest",
  }))
}
