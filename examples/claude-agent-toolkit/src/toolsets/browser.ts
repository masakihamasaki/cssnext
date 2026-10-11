import type Anthropic from "@anthropic-ai/sdk"
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Locator,
  Page,
  Request as PlaywrightRequest,
} from "playwright"

import type { ToolsetCall, ToolsetExecutor, ToolsetOutcome } from "./loop.ts"

/**
 * One `tools[]` entry, no `name`.
 *
 * `read_console`, `read_network`, `javascript_exec` and `file_upload` are
 * withheld from the model unless you switch them on here — they are the members
 * that read or write beyond the page, so they are opt-in.
 */
export function browserToolset(
  configs?: Anthropic.BrowserToolsetConfigs
): Anthropic.ToolUnion {
  return {
    type: "browser_toolset_20260801",
    ...(configs ? { configs } : {}),
  }
}

export interface BrowserExecutorOptions {
  /** Only these hosts may be navigated to. Everything else is refused. */
  allowedHosts?: string[]
  headless?: boolean
  viewport?: { width: number; height: number }
  /** Where downloads triggered by the page are written. */
  downloadDir?: string
  /**
   * Path to a Chromium binary. This environment ships one at
   * /opt/pw-browsers/chromium, so no browser download is needed.
   */
  executablePath?: string
  configs?: Anthropic.BrowserToolsetConfigs
}

interface TabState {
  id: string
  page: Page
  console: string[]
  network: string[]
}

type StateChange = Anthropic.BrowserStateChange

const REF_ATTRIBUTE = "data-claude-ref"

/**
 * A Playwright-backed host for `browser_toolset_20260801`.
 *
 * The point of the browser toolset over raw computer use is that the model does
 * not have to aim: `read_page` and `find` hand it `[ref_N]` handles derived from
 * the page's own structure, and `left_click`/`form_input` accept those handles
 * instead of coordinates. A layout shift moves the pixels but not the refs, so
 * the run does not break.
 */
export class BrowserExecutor implements ToolsetExecutor {
  readonly toolsetName = "browser"
  readonly haltText = "Not executed: an earlier action in this turn failed."
  readonly toolDefinition: Anthropic.ToolUnion

  private browser?: Browser
  private context?: BrowserContext
  private readonly tabs = new Map<string, TabState>()
  private activeTabId?: string
  private tabCounter = 0
  private downloadCounter = 0
  private pendingStateChanges: StateChange[] = []
  private readonly options: BrowserExecutorOptions

  constructor(options: BrowserExecutorOptions = {}) {
    this.options = options
    this.toolDefinition = browserToolset(options.configs)
  }

  async close(): Promise<void> {
    await this.context?.close()
    await this.browser?.close()
  }

  async execute(call: ToolsetCall): Promise<ToolsetOutcome> {
    await this.ensureBrowser()
    const { name, input } = call

    // Tab-inventory members answer about the browser rather than a page.
    if (name === "new_tab") {
      const tab = await this.openTab()
      this.activeTabId = tab.id
      this.pendingStateChanges.push({ type: "tab_opened", tab_id: tab.id })
      return await this.ok(`Opened ${tab.id}`)
    }
    if (name === "list_tabs") {
      return await this.ok(`${this.tabs.size} tab(s) open`)
    }
    if (name === "switch_tab") {
      const id = String(input.tab_id ?? "")
      const tab = this.tabs.get(id)
      if (!tab) return this.fail(`Error: no tab with id "${id}".`)
      this.activeTabId = id
      await tab.page.bringToFront()
      return await this.ok(`Switched to ${id}`)
    }
    if (name === "close_tab") {
      const id = String(input.tab_id ?? "")
      const tab = this.tabs.get(id)
      if (!tab) return this.fail(`Error: no tab with id "${id}".`)
      await tab.page.close()
      this.tabs.delete(id)
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs.keys().next().value
      }
      return await this.ok(`Closed ${id}`)
    }

    const tab = this.resolveTab(input.tab_id)
    if (!tab) return this.fail("Error: no open tab to act on.")
    const { page } = tab

    try {
      switch (name) {
        case "navigate": {
          const url = String(input.url ?? "")
          if (url === "back") {
            await page.goBack()
          } else if (url === "forward") {
            await page.goForward()
          } else if (url === "reload") {
            await page.reload()
          } else {
            const refusal = this.checkUrl(url)
            if (refusal) return this.fail(refusal)
            await page.goto(url, { waitUntil: "domcontentloaded" })
          }
          // Refs are stamped onto DOM nodes, so navigating drops them all. The
          // model is told to read the page again when one goes stale.
          return await this.ok(`Navigated to ${page.url()}`)
        }

        case "screenshot": {
          const png = await page.screenshot({ type: "png" })
          return await this.okImage(png)
        }

        case "zoom": {
          const region = numbers(input.region, 4)
          const png = await page.screenshot({
            type: "png",
            clip: {
              x: region[0]!,
              y: region[1]!,
              width: Math.max(1, region[2]! - region[0]!),
              height: Math.max(1, region[3]! - region[1]!),
            },
          })
          return await this.okImage(png)
        }

        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click": {
          const button =
            name === "right_click"
              ? "right"
              : name === "middle_click"
                ? "middle"
                : "left"
          const clickCount =
            name === "double_click" ? 2 : name === "triple_click" ? 3 : 1
          const mods = playwrightModifiers(input.modifiers)
          const target = await this.resolveTarget(tab, input.target)
          if (target.kind === "locator") {
            await target.locator.click({
              button,
              clickCount,
              ...(mods.length ? { modifiers: mods } : {}),
            })
          } else {
            await page.mouse.click(target.x, target.y, {
              button,
              clickCount,
            })
          }
          return await this.ok("OK")
        }

        case "hover": {
          const target = await this.resolveTarget(tab, input.target)
          if (target.kind === "locator") await target.locator.hover()
          else await page.mouse.move(target.x, target.y)
          return await this.ok("OK")
        }

        case "left_click_drag": {
          const from = await this.resolveCoordinate(tab, input.from)
          const to = await this.resolveCoordinate(tab, input.target)
          await page.mouse.move(from.x, from.y)
          await page.mouse.down()
          await page.mouse.move(to.x, to.y, { steps: 12 })
          await page.mouse.up()
          return await this.ok("OK")
        }

        case "left_mouse_down": {
          const at = await this.resolveCoordinate(tab, input.target)
          await page.mouse.move(at.x, at.y)
          await page.mouse.down()
          return await this.ok("OK")
        }

        case "left_mouse_up": {
          const at = await this.resolveCoordinate(tab, input.target)
          await page.mouse.move(at.x, at.y)
          await page.mouse.up()
          return await this.ok("OK")
        }

        case "mouse_move": {
          const at = await this.resolveCoordinate(tab, input.target)
          await page.mouse.move(at.x, at.y)
          return await this.ok("OK")
        }

        case "scroll": {
          const at = await this.resolveCoordinate(tab, input.target)
          const amount = clamp(Number(input.scroll_amount ?? 3), 1, 10)
          const step = amount * 100
          const direction = String(input.scroll_direction ?? "down")
          const delta = {
            up: [0, -step],
            down: [0, step],
            left: [-step, 0],
            right: [step, 0],
          }[direction]
          if (!delta) return this.fail(`Error: unknown scroll_direction "${direction}".`)
          await page.mouse.move(at.x, at.y)
          await page.mouse.wheel(delta[0]!, delta[1]!)
          return await this.ok("OK")
        }

        case "scroll_to": {
          const locator = await this.requireRef(tab, input.target)
          await locator.scrollIntoViewIfNeeded()
          return await this.ok("OK")
        }

        case "type":
          await page.keyboard.type(String(input.text ?? ""))
          return await this.ok("OK")

        case "key": {
          const repeat = clamp(Number(input.repeat ?? 1), 1, 100)
          const chords = String(input.text ?? "")
            .split(/\s+/)
            .filter(Boolean)
            .map(playwrightKey)
          for (let i = 0; i < repeat; i++) {
            for (const chord of chords) await page.keyboard.press(chord)
          }
          return await this.ok("OK")
        }

        case "hold_key": {
          const chord = playwrightKey(String(input.text ?? ""))
          await page.keyboard.down(chord)
          try {
            await sleep(clamp(Number(input.duration ?? 0), 0, 30) * 1000)
          } finally {
            await page.keyboard.up(chord)
          }
          return await this.ok("OK")
        }

        case "wait":
          await sleep(clamp(Number(input.duration ?? 0), 0, 30) * 1000)
          return await this.ok("OK")

        case "read_page": {
          const tree = await this.readPage(tab, {
            filter: input.filter === "all" ? "all" : "interactive",
            depth: clamp(Number(input.depth ?? 15), 1, 100),
            ref: typeof input.ref === "string" ? input.ref : undefined,
          })
          return await this.ok(tree || "(no matching elements)")
        }

        case "find": {
          const matches = await this.find(tab, String(input.query ?? ""))
          return await this.ok(
            matches.length
              ? matches.join("\n")
              : `No elements matched "${String(input.query ?? "")}".`
          )
        }

        case "get_page_text": {
          const text = await page.evaluate(() => document.body?.innerText ?? "")
          return await this.ok(text.slice(0, 100_000))
        }

        case "form_input": {
          const locator = await this.requireRef(tab, input.target)
          const value = input.value
          const tagName = (
            await locator.evaluate((element) => element.tagName)
          ).toLowerCase()
          if (tagName === "select") {
            await locator.selectOption(String(value))
          } else if (typeof value === "boolean") {
            await locator.setChecked(value)
          } else {
            await locator.fill(String(value ?? ""))
          }
          return await this.ok("OK")
        }

        case "file_upload": {
          const locator = await this.requireRef(tab, input.target)
          const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
          if (!paths.length) {
            // `document_ids` refers to files your application staged. Map them
            // to local paths before they reach Playwright.
            return this.fail(
              "Error: file_upload needs `paths`; `document_ids` are not resolvable here."
            )
          }
          await locator.setInputFiles(paths)
          return await this.ok(`Uploaded ${paths.length} file(s)`)
        }

        case "read_console": {
          const entries = tab.console.splice(0)
          return await this.ok(entries.length ? entries.join("\n") : "(no console entries)")
        }

        case "read_network": {
          const entries = tab.network.splice(0)
          return await this.ok(entries.length ? entries.join("\n") : "(no network activity)")
        }

        case "javascript_exec": {
          const result: unknown = await page.evaluate(String(input.text ?? ""))
          return await this.ok(
            typeof result === "string" ? result : JSON.stringify(result) ?? "undefined"
          )
        }

        default:
          return this.fail(`Error: unknown browser member "${name}".`)
      }
    } catch (error) {
      return this.fail(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Result helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * A successful result carries the tab inventory. State changes are attached
   * to the result of the call during which they happened and never sent as an
   * empty array; failures carry no `browser_state` at all.
   */
  private async ok(text: string): Promise<ToolsetOutcome> {
    return {
      content: [{ type: "text", text }, await this.browserState()],
    }
  }

  private async okImage(png: Buffer): Promise<ToolsetOutcome> {
    return {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: png.toString("base64"),
          },
        },
        await this.browserState(),
      ],
    }
  }

  private fail(text: string): ToolsetOutcome {
    return { content: text, isError: true }
  }

  /**
   * The full tab inventory, never a delta, with exactly one entry marked
   * active whenever it is non-empty. `state_changes` is omitted rather than
   * sent empty, and is drained here so each change is reported exactly once,
   * on the result of the call during which it happened.
   */
  private async browserState(): Promise<Anthropic.BrowserStateBlockParam> {
    const tabs: Anthropic.BrowserStateTabEntry[] = []
    for (const tab of this.tabs.values()) {
      tabs.push({
        tab_id: tab.id,
        title: truncate(await tab.page.title().catch(() => "")),
        url: truncate(tab.page.url()),
        ...(tab.id === this.activeTabId ? { active: true } : {}),
      })
    }
    const changes = this.pendingStateChanges.splice(0)
    return {
      type: "browser_state",
      tabs,
      ...(changes.length ? { state_changes: changes } : {}),
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Page reading                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Walk the DOM, stamp every element the model could act on with a
   * `data-claude-ref` attribute, and return an indented outline tagged with
   * `[ref_N]`. Refs stay valid until the page navigates or the DOM changes
   * enough that the stamped nodes are gone, at which point the model reads the
   * page again.
   */
  private async readPage(
    tab: TabState,
    options: { filter: "interactive" | "all"; depth: number; ref?: string }
  ): Promise<string> {
    return tab.page.evaluate(
      ({ filter, depth, ref, attribute }) => {
        const INTERACTIVE = new Set([
          "a",
          "button",
          "input",
          "select",
          "textarea",
          "summary",
          "option",
        ])

        let counter = 0
        const lines: string[] = []

        const roleOf = (element: Element): string => {
          const explicit = element.getAttribute("role")
          if (explicit) return explicit
          const tag = element.tagName.toLowerCase()
          if (tag === "a") return (element as HTMLAnchorElement).href ? "link" : "generic"
          if (tag === "button") return "button"
          if (tag === "select") return "combobox"
          if (tag === "textarea") return "textbox"
          if (tag === "input") {
            const type = (element as HTMLInputElement).type
            if (type === "checkbox") return "checkbox"
            if (type === "radio") return "radio"
            if (type === "submit" || type === "button") return "button"
            return "textbox"
          }
          if (/^h[1-6]$/.test(tag)) return "heading"
          if (tag === "img") return "image"
          if (tag === "nav") return "navigation"
          if (tag === "main") return "main"
          return "generic"
        }

        const nameOf = (element: Element): string => {
          const label =
            element.getAttribute("aria-label") ??
            element.getAttribute("alt") ??
            element.getAttribute("placeholder") ??
            element.getAttribute("title")
          if (label) return label.trim()
          if (element instanceof HTMLInputElement && element.labels?.length) {
            return element.labels[0]?.innerText.trim() ?? ""
          }
          const text = (element as HTMLElement).innerText ?? ""
          return text.trim().replace(/\s+/g, " ").slice(0, 120)
        }

        const visible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return false
          const style = window.getComputedStyle(element)
          return style.visibility !== "hidden" && style.display !== "none"
        }

        const isInteractive = (element: Element): boolean =>
          INTERACTIVE.has(element.tagName.toLowerCase()) ||
          element.hasAttribute("onclick") ||
          element.getAttribute("tabindex") === "0" ||
          Boolean(element.getAttribute("role"))

        const walk = (element: Element, level: number): void => {
          if (level > depth) return
          if (!visible(element)) return

          const interactive = isInteractive(element)
          if (filter === "all" || interactive) {
            const role = roleOf(element)
            const name = nameOf(element)
            if (role !== "generic" || name) {
              let tag = ""
              if (interactive) {
                counter += 1
                const id = `ref_${counter}`
                element.setAttribute(attribute, id)
                tag = ` [${id}]`
              }
              lines.push(
                `${"  ".repeat(level)}${role}${name ? ` "${name}"` : ""}${tag}`
              )
            }
          }

          for (const child of Array.from(element.children)) {
            walk(child, level + 1)
          }
        }

        const root = ref
          ? document.querySelector(`[${attribute}="${ref}"]`)
          : document.body
        if (!root) return ""
        walk(root, 0)
        return lines.join("\n")
      },
      {
        filter: options.filter,
        depth: options.depth,
        ref: options.ref ?? null,
        attribute: REF_ATTRIBUTE,
      }
    )
  }

  /** Up to 20 elements whose role or accessible name matches the query. */
  private async find(tab: TabState, query: string): Promise<string[]> {
    const outline = await this.readPage(tab, { filter: "all", depth: 40 })
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2)
    return outline
      .split("\n")
      .filter((line) => {
        if (!line.includes("[ref_")) return false
        const haystack = line.toLowerCase()
        return terms.length === 0 || terms.some((term) => haystack.includes(term))
      })
      .slice(0, 20)
      .map((line) => line.trim())
  }

  /* ---------------------------------------------------------------------- */
  /* Targets                                                                 */
  /* ---------------------------------------------------------------------- */

  private async resolveTarget(
    tab: TabState,
    target: unknown
  ): Promise<
    { kind: "locator"; locator: Locator } | { kind: "point"; x: number; y: number }
  > {
    const spec = target as { type?: string; ref?: string; x?: number; y?: number }
    if (spec?.type === "ref") {
      return { kind: "locator", locator: await this.requireRef(tab, target) }
    }
    if (spec?.type === "coordinate") {
      return { kind: "point", x: Number(spec.x), y: Number(spec.y) }
    }
    throw new Error(`Unsupported target ${JSON.stringify(target)}`)
  }

  private async resolveCoordinate(
    tab: TabState,
    target: unknown
  ): Promise<{ x: number; y: number }> {
    const resolved = await this.resolveTarget(tab, target)
    if (resolved.kind === "point") return { x: resolved.x, y: resolved.y }
    const box = await resolved.locator.boundingBox()
    if (!box) throw new Error("Element has no layout box")
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  private async requireRef(tab: TabState, target: unknown): Promise<Locator> {
    const spec = target as { type?: string; ref?: string }
    if (spec?.type !== "ref" || !spec.ref) {
      throw new Error("This member needs a ref target; call read_page or find first")
    }
    const locator = tab.page.locator(`[${REF_ATTRIBUTE}="${spec.ref}"]`)
    if ((await locator.count()) === 0) {
      throw new Error(
        `${spec.ref} is stale; the page changed. Call read_page again for fresh refs`
      )
    }
    return locator.first()
  }

  /* ---------------------------------------------------------------------- */
  /* Browser lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  private resolveTab(tabId: unknown): TabState | undefined {
    if (typeof tabId === "string" && tabId) return this.tabs.get(tabId)
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
  }

  private checkUrl(url: string): string | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return `Error: "${url}" is not a URL.`
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Error: Navigation refused. Only http and https URLs are allowed."
    }
    const allowed = this.options.allowedHosts
    if (allowed?.length) {
      const permitted = allowed.some(
        (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      )
      if (!permitted) {
        return `Error: Navigation refused. ${parsed.hostname} is not in the allowlist.`
      }
    }
    return undefined
  }

  private async ensureBrowser(): Promise<void> {
    if (this.context) return
    const { chromium } = await import("playwright")
    this.browser = await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.executablePath
        ? { executablePath: this.options.executablePath }
        : {}),
    })
    this.context = await this.browser.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 800 },
      acceptDownloads: true,
    })
    const first = await this.openTab()
    this.activeTabId = first.id
  }

  private async openTab(): Promise<TabState> {
    if (!this.context) throw new Error("Browser context is not started")
    const page = await this.context.newPage()
    const id = `tab-${++this.tabCounter}`
    const tab: TabState = { id, page, console: [], network: [] }

    page.on("console", (message: ConsoleMessage) => {
      tab.console.push(`[${message.type()}] ${message.text()}`)
      if (tab.console.length > 200) tab.console.shift()
    })
    page.on("requestfinished", (request: PlaywrightRequest) => {
      tab.network.push(`${request.method()} ${request.url()}`)
      if (tab.network.length > 200) tab.network.shift()
    })
    page.on("download", (download) => {
      const downloadId = `dl-${++this.downloadCounter}`
      const url = download.url()
      this.pendingStateChanges.push({ type: "download_started", download_id: downloadId, url })
      void download
        .path()
        .then(async (path) => {
          if (!path) throw new Error("download was cancelled")
          const target = this.options.downloadDir
            ? `${this.options.downloadDir}/${download.suggestedFilename()}`
            : path
          if (this.options.downloadDir) await download.saveAs(target)
          const { stat } = await import("node:fs/promises")
          const size = await stat(target).then((info) => info.size, () => 0)
          this.pendingStateChanges.push({
            type: "download_completed",
            download_id: downloadId,
            url,
            path: target,
            size_bytes: size,
          })
        })
        .catch((error: unknown) => {
          this.pendingStateChanges.push({
            type: "download_failed",
            download_id: downloadId,
            url,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    })

    this.tabs.set(id, tab)
    return tab
  }
}

/** Tab titles and URLs are capped at 4,096 characters and carry no control characters. */
function truncate(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 4096)
}

function numbers(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Expected ${length} numbers, got ${JSON.stringify(value)}`)
  }
  return value.map(Number)
}

function playwrightModifiers(
  value: unknown
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  const list = Array.isArray(value) ? value.map(String) : []
  const mapping: Record<string, "Alt" | "Control" | "Meta" | "Shift"> = {
    alt: "Alt",
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    shift: "Shift",
  }
  return list
    .map((entry) => mapping[entry.toLowerCase()])
    .filter((entry): entry is "Alt" | "Control" | "Meta" | "Shift" => Boolean(entry))
}

/** "ctrl+a" -> "Control+a", "Return" -> "Enter". */
function playwrightKey(chord: string): string {
  const aliases: Record<string, string> = {
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    super: "Meta",
    meta: "Meta",
    alt: "Alt",
    shift: "Shift",
    return: "Enter",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    space: "Space",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  }
  return chord
    .split("+")
    .map((part) => aliases[part.toLowerCase()] ?? part)
    .join("+")
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
