import { createReadStream } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { basename, extname } from "node:path"

import Anthropic, { toFile } from "@anthropic-ai/sdk"

import { client } from "./client.ts"

/**
 * The Files API is "upload once, reference many times". A `file_id` costs
 * nothing to keep around, uploads and downloads are free, and only the bytes
 * that actually enter a Messages request are billed as input tokens.
 *
 * Limits worth designing around: 500 MB per file, 1 TB per organisation.
 *
 * Files are scoped to the *workspace* of the uploading key, not to a user or a
 * conversation. Any key in the same workspace can read any file in it, so never
 * accept a `file_id` from an end user, and give each tenant of a multi-tenant
 * application its own workspace.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
}

export function mimeTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
}

export interface UploadOptions {
  /**
   * Seconds until the file expires, between 3600 (1 hour) and 7776000 (90
   * days). Set once at upload and never changeable afterwards. Leave it unset
   * for a file that should live until you delete it.
   */
  expiresInSeconds?: number
  mimeType?: string
  filename?: string
}

/** Upload a local file and return its metadata, including the `file_id`. */
export async function uploadFile(
  path: string,
  options: UploadOptions = {}
): Promise<Anthropic.FileMetadata> {
  return client.files.upload({
    file: await toFile(
      createReadStream(path),
      options.filename ?? basename(path),
      { type: options.mimeType ?? mimeTypeFor(path) }
    ),
    ...(options.expiresInSeconds
      ? { expires_in_seconds: options.expiresInSeconds }
      : {}),
  })
}

/**
 * Upload only if the same bytes have not been uploaded already.
 *
 * The Files API has no dedupe of its own, so re-running a script would pile up
 * copies against the 1 TB quota. This keeps a small local index keyed by the
 * file's SHA-256 and re-checks each remembered id against the API, so an entry
 * for a file that was deleted or has expired is replaced rather than trusted.
 */
export async function uploadFileOnce(
  path: string,
  indexPath: string,
  options: UploadOptions = {}
): Promise<Anthropic.FileMetadata> {
  const { createHash } = await import("node:crypto")
  const digest = createHash("sha256").update(await readFile(path)).digest("hex")

  const index: Record<string, string> = await readJson(indexPath)
  const remembered = index[digest]

  if (remembered) {
    const existing = await client.files
      .retrieveMetadata(remembered)
      .catch(() => undefined)
    const expired =
      existing?.expires_at && new Date(existing.expires_at) <= new Date()
    if (existing && !expired) return existing
  }

  const uploaded = await uploadFile(path, options)
  index[digest] = uploaded.id
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  return uploaded
}

/**
 * The content block a `file_id` belongs in depends on the file's MIME type:
 * PDFs and text become `document`, images become `image`, and anything the code
 * execution tool should read becomes `container_upload`. Mismatching the two is
 * a 400.
 */
export function fileBlock(
  file: Pick<Anthropic.FileMetadata, "id" | "mime_type">,
  forCodeExecution = false
): Anthropic.ContentBlockParam {
  if (forCodeExecution) {
    return { type: "container_upload", file_id: file.id }
  }
  if (file.mime_type.startsWith("image/")) {
    return { type: "image", source: { type: "file", file_id: file.id } }
  }
  return { type: "document", source: { type: "file", file_id: file.id } }
}

/**
 * Every `file_id` produced inside a response by the code execution tool or a
 * skill. Those are the only files that can be downloaded; a file you uploaded
 * has `downloadable: false` and returns a 400.
 */
export function generatedFileIds(message: Anthropic.Message): string[] {
  const ids: string[] = []
  for (const block of message.content) {
    if (block.type !== "bash_code_execution_tool_result") continue
    const content = block.content as unknown
    if (!content || typeof content !== "object") continue
    const outputs = (content as { content?: Array<{ type?: string; file_id?: string }> })
      .content
    for (const output of outputs ?? []) {
      if (output?.file_id) ids.push(output.file_id)
    }
  }
  return ids
}

/** Download a generated file to disk and return the path written. */
export async function downloadFile(
  fileId: string,
  destination: string
): Promise<string> {
  const response = await client.files.download(fileId)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
  return destination
}

/** Walk every page of the workspace's file list. */
export async function listAllFiles(): Promise<Anthropic.FileMetadata[]> {
  const files: Anthropic.FileMetadata[] = []
  for await (const file of client.files.list({ limit: 100 })) files.push(file)
  return files
}

async function readJson(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}
