/**
 * Offline checks for the parts that do not need the Claude API.
 *
 *   node --experimental-strip-types scripts/smoke.ts
 *
 * Drives the browser executor with the exact `tool_use` shapes the model emits,
 * and asserts the `tool_result` shapes that go back. Everything here runs
 * against a local page, so it costs nothing and needs no credentials.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"

import type Anthropic from "@anthropic-ai/sdk"

import { BrowserExecutor } from "../src/toolsets/browser.ts"
import { executeBatch } from "../src/toolsets/loop.ts"
import type {
  ToolsetCall,
  ToolsetExecutor,
  ToolsetOutcome,
} from "../src/toolsets/loop.ts"
import { readSkillFrontmatter } from "../src/skills.ts"

const PAGE = `<!doctype html>
<html><head><title>Fixture</title></head><body>
  <h1>Stylesheet review</h1>
  <nav><a href="/docs" id="docs">Getting started</a></nav>
  <form>
    <label for="q">Search docs</label>
    <input id="q" name="q" placeholder="Search docs">
    <select id="mode"><option value="fast">Fast</option><option value="deep">Deep</option></select>
    <input type="checkbox" id="strict" aria-label="Strict mode">
    <button type="button" id="go" onclick="document.title='clicked'">Run search</button>
  </form>
  <p>The card uses a custom property for its brand colour.</p>
</body></html>`

let failures = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}\n`)
  }
}

/** The text of a result, whether it came back as a string or as blocks. */
function textOf(outcome: ToolsetOutcome): string {
  if (typeof outcome.content === "string") return outcome.content
  return (outcome.content ?? [])
    .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

function stateOf(outcome: ToolsetOutcome): Anthropic.BrowserStateBlockParam | undefined {
  if (typeof outcome.content === "string") return undefined
  return (outcome.content ?? []).find(
    (block): block is Anthropic.BrowserStateBlockParam => block.type === "browser_state"
  )
}

/** Records what it was asked to do and fails on demand. */
class FakeExecutor implements ToolsetExecutor {
  readonly toolDefinition = { type: "computer_toolset_20260801" } as const
  readonly seen: string[] = []

  readonly toolsetName: string
  readonly haltText: string
  private readonly failOn: string | undefined

  constructor(toolsetName: string, haltText: string, failOn?: string) {
    this.toolsetName = toolsetName
    this.haltText = haltText
    this.failOn = failOn
  }

  async execute(call: ToolsetCall): Promise<ToolsetOutcome> {
    this.seen.push(call.name)
    if (call.name === this.failOn) {
      return { content: "Error: boom", isError: true }
    }
    if (call.name === "throw") throw new Error("unhandled")
    return { content: "OK" }
  }
}

async function checkBatching(): Promise<void> {
  process.stdout.write("batch contract\n")

  const computer = new FakeExecutor("computer", "halt-computer", "type")
  const browser = new FakeExecutor("browser", "halt-browser")
  const byName = new Map<string, ToolsetExecutor>([
    ["computer", computer],
    ["browser", browser],
  ])

  const results = await executeBatch(
    [
      { id: "a", name: "left_click", input: {}, toolset_name: "computer" },
      { id: "b", name: "type", input: {}, toolset_name: "computer" },
      { id: "c", name: "screenshot", input: {}, toolset_name: "computer" },
      { id: "d", name: "read_page", input: {}, toolset_name: "browser" },
      { id: "e", name: "whatever", input: {}, toolset_name: "unregistered" },
    ],
    byName
  )

  check("every call gets exactly one result", results.length === 5)
  check(
    "results keep the model's order",
    results.map((result) => result.tool_use_id).join(",") === "a,b,c,d,e"
  )
  check(
    "every result echoes its toolset_name",
    results
      .slice(0, 4)
      .every((result, index) =>
        index < 3 ? result.toolset_name === "computer" : result.toolset_name === "browser"
      )
  )
  check("the failing call is marked", results[1]?.is_error === true)
  check(
    "the rest of that family is skipped, not run",
    results[2]?.is_error === true && results[2]?.content === "halt-computer"
  )
  check(
    "a skipped member is never executed",
    !computer.seen.includes("screenshot"),
    computer.seen.join(",")
  )
  check(
    "the other family is unaffected",
    results[3]?.is_error === undefined && browser.seen.includes("read_page")
  )
  check("an unroutable call still gets a result", results[4]?.is_error === true)

  const thrown = await executeBatch(
    [{ id: "x", name: "throw", input: {}, toolset_name: "browser" }],
    byName
  )
  check(
    "an executor that throws becomes an error result",
    thrown[0]?.is_error === true && String(thrown[0]?.content).includes("unhandled")
  )
}

async function main(): Promise<void> {
  await checkBatching()

  process.stdout.write("skills\n")
  const frontmatter = await readSkillFrontmatter(
    join(import.meta.dirname, "..", "skills", "css-modernizer")
  )
  check("SKILL.md frontmatter parses", frontmatter.name === "css-modernizer")
  check("description is present", frontmatter.description.length > 0)

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address === "string" || !address) throw new Error("no port")
  const origin = `http://127.0.0.1:${address.port}`

  const executor = new BrowserExecutor({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    allowedHosts: ["127.0.0.1"],
  })

  let call = 0
  const run = (name: string, input: Record<string, unknown> = {}) =>
    executor.execute({ id: `toolu_${++call}`, name, input })

  try {
    process.stdout.write("browser toolset\n")

    const navigated = await run("navigate", { url: origin })
    check("navigate succeeds", !navigated.isError, textOf(navigated))
    const state = stateOf(navigated)
    check("result carries browser_state", Boolean(state))
    check("inventory has one tab", state?.tabs.length === 1)
    check("that tab is active", state?.tabs[0]?.active === true)
    check("title is reported", state?.tabs[0]?.title === "Fixture")
    check(
      "no empty state_changes array",
      !("state_changes" in (state ?? {})) || (state?.state_changes?.length ?? 0) > 0
    )

    const offsite = await run("navigate", { url: "https://example.net/" })
    check("allowlist refuses other hosts", offsite.isError === true)
    check(
      "refusal carries no browser_state",
      typeof offsite.content === "string"
    )

    const badScheme = await run("navigate", { url: "file:///etc/passwd" })
    check("non-http scheme refused", badScheme.isError === true)

    const page = await run("read_page", { filter: "interactive" })
    const outline = textOf(page)
    check("read_page tags refs", /\[ref_\d+\]/.test(outline), outline.slice(0, 200))
    check("link is listed", outline.includes("Getting started"))
    check("textbox is listed", /textbox/.test(outline))

    const found = await run("find", { query: "search button" })
    check("find returns matches", /\[ref_\d+\]/.test(textOf(found)), textOf(found))

    const inputRef = refFor(outline, "Search docs")
    check("a ref resolves for the search box", Boolean(inputRef))
    if (inputRef) {
      const typed = await run("form_input", {
        target: { type: "ref", ref: inputRef },
        value: "custom properties",
      })
      check("form_input succeeds", !typed.isError, textOf(typed))
    }

    const selectRef = refFor(outline, "Fast")
    if (selectRef) {
      const chosen = await run("form_input", {
        target: { type: "ref", ref: selectRef },
        value: "deep",
      })
      check("form_input drives a select", !chosen.isError, textOf(chosen))
    }

    const buttonRef = refFor(outline, "Run search", "button")
    check("a ref resolves for the button", Boolean(buttonRef))
    if (buttonRef) {
      const clicked = await run("left_click", {
        target: { type: "ref", ref: buttonRef },
      })
      check("left_click by ref succeeds", !clicked.isError, textOf(clicked))
      check(
        "click had an effect on the page",
        stateOf(clicked)?.tabs[0]?.title === "clicked",
        stateOf(clicked)?.tabs[0]?.title
      )
    }

    const stale = await run("left_click", {
      target: { type: "ref", ref: "ref_9999" },
    })
    check("a stale ref is an error, not a crash", stale.isError === true)
    check("stale ref explains the fix", textOf(stale).includes("read_page"))

    const byPoint = await run("left_click", {
      target: { type: "coordinate", x: 10, y: 10 },
    })
    check("coordinate targets still work", !byPoint.isError, textOf(byPoint))

    const text = await run("get_page_text")
    check("get_page_text reads the body", textOf(text).includes("custom property"))

    const shot = await run("screenshot")
    const image = Array.isArray(shot.content)
      ? shot.content.find((block) => block.type === "image")
      : undefined
    check("screenshot returns an image block", Boolean(image))
    check(
      "screenshot is base64 png",
      image?.type === "image" &&
        image.source.type === "base64" &&
        image.source.media_type === "image/png"
    )

    const zoomed = await run("zoom", { region: [0, 0, 200, 100] })
    check("zoom returns an image block", !zoomed.isError, textOf(zoomed))

    const opened = await run("new_tab")
    check("new_tab succeeds", !opened.isError)
    const openedState = stateOf(opened)
    check("inventory grows to two tabs", openedState?.tabs.length === 2)
    check(
      "tab_opened is reported once",
      openedState?.state_changes?.some((change) => change.type === "tab_opened") === true
    )
    const secondId = openedState?.tabs.find((tab) => tab.active)?.tab_id
    check("exactly one tab is active", countActive(openedState) === 1)

    const listed = await run("list_tabs")
    check(
      "state_changes is not repeated on the next result",
      stateOf(listed)?.state_changes === undefined
    )

    if (secondId) {
      const closed = await run("close_tab", { tab_id: secondId })
      check("close_tab succeeds", !closed.isError)
      check("inventory shrinks again", stateOf(closed)?.tabs.length === 1)
      check("an active tab remains", countActive(stateOf(closed)) === 1)
    }

    const missing = await run("switch_tab", { tab_id: "tab-404" })
    check("switching to an unknown tab errors", missing.isError === true)

    const unknown = await run("teleport")
    check("an unknown member errors", unknown.isError === true)

    // Disabled members are withheld from the model by `configs`, but a host
    // must still answer safely if one is somehow requested.
    const console_ = await run("read_console")
    check("read_console answers", !console_.isError, textOf(console_))
  } finally {
    await executor.close()
    server.close()
  }

  process.stdout.write(
    failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`
  )
  assert.equal(failures, 0)
}

/**
 * Pull `ref_N` out of the first outline line mentioning `label`, optionally
 * narrowed to a role. This is what the model does when it reads a page: pick a
 * handle out of the outline and act on it.
 */
function refFor(
  outline: string,
  label: string,
  role?: string
): string | undefined {
  for (const line of outline.split("\n")) {
    if (!line.includes(label)) continue
    if (role && !line.trimStart().startsWith(role)) continue
    const match = /\[(ref_\d+)\]/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

function countActive(state?: Anthropic.BrowserStateBlockParam): number {
  return (state?.tabs ?? []).filter((tab) => tab.active).length
}

await main()
