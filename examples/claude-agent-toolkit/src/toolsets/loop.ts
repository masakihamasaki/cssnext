import type Anthropic from "@anthropic-ai/sdk"

import { client, MODEL, assertToolsetModel } from "../client.ts"
import { log } from "../log.ts"

/**
 * One member call the model asked for, e.g. `left_click` of the `computer`
 * family or `navigate` of the `browser` family.
 *
 * Toolset `tool_use` blocks carry no `action` field: the member name is the
 * block's `name`, and `input` holds only that member's own parameters.
 */
export interface ToolsetCall {
  id: string
  /** Member name, e.g. `screenshot`, `left_click`, `navigate`. */
  name: string
  input: Record<string, unknown>
}

/** What an executor hands back for one member call. */
export interface ToolsetOutcome {
  /**
   * Either a plain string or the content blocks to return. `screenshot` and
   * `zoom` must return an `image` block; browser members may attach a
   * `browser_state` block alongside their text.
   */
  content: Anthropic.ToolResultBlockParam["content"]
  isError?: boolean
}

/**
 * The host side of one toolset family. The API runs the model; this runs the
 * hands.
 */
export interface ToolsetExecutor {
  /**
   * The family name echoed on every `tool_use` and required on every
   * `tool_result` you send back: `"computer"` or `"browser"`.
   */
  readonly toolsetName: string
  /** The `tools[]` entry that declares this family to the API. */
  readonly toolDefinition: Anthropic.ToolUnion
  /**
   * Text used for the members of a batch that were skipped because an earlier
   * member in the same turn failed. The two toolsets word this differently.
   */
  readonly haltText: string
  execute(call: ToolsetCall): Promise<ToolsetOutcome>
  close?(): Promise<void>
}

export interface RunToolsetAgentOptions {
  prompt: string
  executors: ToolsetExecutor[]
  system?: string
  model?: string
  /** Safety valve: give up after this many assistant turns. Default 30. */
  maxTurns?: number
  maxTokens?: number
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  /** Extra `tools[]` entries beyond the toolsets, e.g. bash or text editor. */
  extraTools?: Anthropic.ToolUnion[]
  onText?: (text: string) => void
}

export interface RunToolsetAgentResult {
  /** The full transcript, ready to continue the conversation from. */
  messages: Anthropic.MessageParam[]
  /** Concatenated assistant text across every turn. */
  text: string
  turns: number
  stopReason: Anthropic.Message["stop_reason"]
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Drive a toolset agent to completion.
 *
 * The loop is deliberately explicit because the batching contract is the whole
 * point of the 2026-08-01 toolsets: one assistant turn may contain several
 * member calls (click, then type, then screenshot), and the host has to
 *
 *   1. run them in the order the model emitted them, never concurrently,
 *   2. stop at the first failure and answer the rest with `is_error` and the
 *      family's halt text, and
 *   3. return every `tool_result` in a single user message, each echoing the
 *      `toolset_name` of its paired `tool_use`.
 *
 * Splitting the results across several user messages, or dropping the results
 * of skipped members, teaches the model to stop batching and gives back the
 * round trips this release was meant to save.
 */
export async function runToolsetAgent(
  options: RunToolsetAgentOptions
): Promise<RunToolsetAgentResult> {
  const {
    prompt,
    executors,
    system,
    model = MODEL,
    maxTurns = 30,
    maxTokens = 16000,
    effort = "high",
    extraTools = [],
    onText,
  } = options

  assertToolsetModel(model)

  const byName = new Map<string, ToolsetExecutor>()
  for (const executor of executors) byName.set(executor.toolsetName, executor)

  const tools: Anthropic.ToolUnion[] = [
    ...executors.map((executor) => executor.toolDefinition),
    ...extraTools,
  ]

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]
  const textParts: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let turns = 0
  let stopReason: Anthropic.Message["stop_reason"] = null

  while (turns < maxTurns) {
    turns++

    // Stream so that a long agentic turn cannot hit the request timeout, then
    // take the assembled message rather than handling individual events.
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      thinking: { type: "adaptive" },
      output_config: { effort },
      tools,
      messages,
    })
    const response = await stream.finalMessage()

    inputTokens += response.usage.input_tokens
    outputTokens += response.usage.output_tokens
    stopReason = response.stop_reason

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        textParts.push(block.text)
        onText?.(block.text)
      }
    }

    // Echo the assistant content back verbatim. Thinking blocks in particular
    // must be replayed unchanged when continuing on the same model.
    messages.push({ role: "assistant", content: response.content })

    if (response.stop_reason === "refusal") {
      log.detail(
        `refused: ${response.stop_details?.category ?? "unknown category"}`
      )
      break
    }
    if (response.stop_reason !== "tool_use") break

    const calls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    )
    if (calls.length === 0) break

    // Exactly one user message carrying every result of the batch.
    messages.push({ role: "user", content: await executeBatch(calls, byName) })
  }

  return {
    messages,
    text: textParts.join("\n"),
    turns,
    stopReason,
    usage: { inputTokens, outputTokens },
  }
}

/**
 * Run one turn's worth of member calls and build the results.
 *
 * Exported separately from the loop so the batching contract can be exercised
 * without an API call. The rules it implements:
 *
 *   - calls run in the order the model emitted them, one at a time,
 *   - the first failure halts the *rest of that family's* calls in this turn,
 *     which are answered with the family's halt text and `is_error`,
 *   - a failure in one family does not cancel another family batched alongside
 *     it, and
 *   - every call gets exactly one result, echoing its `toolset_name`.
 */
export async function executeBatch(
  calls: Array<Pick<Anthropic.ToolUseBlock, "id" | "name" | "input" | "toolset_name">>,
  byName: Map<string, ToolsetExecutor>
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = []
  const halted = new Set<string>()

  for (const call of calls) {
    const family = call.toolset_name ?? ""
    const executor = byName.get(family)

    if (!executor) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        ...(family ? { toolset_name: family } : {}),
        is_error: true,
        content: `No executor is registered for tool "${call.name}".`,
      })
      continue
    }

    if (halted.has(family)) {
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        toolset_name: family,
        is_error: true,
        content: executor.haltText,
      })
      continue
    }

    log.detail(`${family}.${call.name} ${summarize(call.input)}`)

    let outcome: ToolsetOutcome
    try {
      outcome = await executor.execute({
        id: call.id,
        name: call.name,
        input: (call.input ?? {}) as Record<string, unknown>,
      })
    } catch (error) {
      outcome = {
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    if (outcome.isError) halted.add(family)

    results.push({
      type: "tool_result",
      tool_use_id: call.id,
      toolset_name: family,
      ...(outcome.isError ? { is_error: true } : {}),
      content: outcome.content ?? "",
    })
  }

  return results
}

function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const json = JSON.stringify(input)
  return json.length > 120 ? `${json.slice(0, 117)}...` : json
}
