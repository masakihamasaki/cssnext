import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import type Anthropic from "@anthropic-ai/sdk"

import type { ToolsetCall, ToolsetExecutor, ToolsetOutcome } from "./loop.ts"

const run = promisify(execFile)

/**
 * The whole toolset is one `tools[]` entry carrying no `name`.
 *
 * `display_width_px`, `display_height_px`, `display_number` and `enable_zoom`
 * were fields of the old single `computer_20251124` tool and are rejected here.
 * The screen size is whatever your executor's screenshots say it is, and zoom is
 * turned off through `configs.zoom.enabled` rather than a top-level flag.
 */
export function computerToolset(
  configs?: Anthropic.ComputerToolsetConfigs
): Anthropic.ToolUnion {
  return {
    type: "computer_toolset_20260801",
    ...(configs ? { configs } : {}),
  }
}

/**
 * The minimum a machine has to be able to do to be driven by the toolset.
 *
 * Implement this against a VM, a container, a phone farm, whatever — the loop
 * and the coordinate handling above it stay the same. `X11Display` below is a
 * reference implementation for a Linux box running an X server.
 */
export interface ComputerDisplay {
  /** Full-screen PNG, plus the pixel size of the image that was captured. */
  screenshot(): Promise<{ png: Buffer; width: number; height: number }>
  moveMouse(x: number, y: number): Promise<void>
  click(button: "left" | "right" | "middle", clicks: number): Promise<void>
  mouseDown(): Promise<void>
  mouseUp(): Promise<void>
  cursorPosition(): Promise<{ x: number; y: number }>
  scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKey(chord: string, repeat: number): Promise<void>
  keyDown(key: string): Promise<void>
  keyUp(key: string): Promise<void>
  close?(): Promise<void>
}

export interface ComputerExecutorOptions {
  display: ComputerDisplay
  /**
   * Longest edge of the screenshots handed to the model.
   *
   * Claude Opus 4.7 and later accept images up to 2576px on the long edge and
   * about 3.75 megapixels, but 1080p is the usual sweet spot for cost against
   * accuracy; 1366x768 or 720p are cheaper still. Whatever you pick, the model
   * sees only the scaled image, so coordinates it sends back are in scaled
   * pixels and must be divided by the scale factor before they reach the real
   * screen. That conversion is the single most common source of clicks landing
   * in the wrong place, and it is handled once, here.
   */
  maxLongEdge?: number
  configs?: Anthropic.ComputerToolsetConfigs
}

export class ComputerExecutor implements ToolsetExecutor {
  readonly toolsetName = "computer"
  readonly haltText =
    "Not executed: an earlier computer action in this turn failed."
  readonly toolDefinition: Anthropic.ToolUnion

  private readonly display: ComputerDisplay
  private readonly maxLongEdge: number
  /** Screenshot pixels per real screen pixel, from the last capture. */
  private scale = 1

  constructor(options: ComputerExecutorOptions) {
    this.display = options.display
    this.maxLongEdge = options.maxLongEdge ?? 1920
    this.toolDefinition = computerToolset(options.configs)
  }

  async close(): Promise<void> {
    await this.display.close?.()
  }

  async execute(call: ToolsetCall): Promise<ToolsetOutcome> {
    const { name, input } = call

    switch (name) {
      case "screenshot":
        return this.capture()

      case "zoom": {
        // Zoom crops the last screenshot's coordinate space and returns it at
        // full resolution. It does not change the coordinate space: the model
        // keeps addressing the full screenshot.
        const region = coordinates(input.region, 4)
        return this.capture(region as [number, number, number, number])
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
        const clicks =
          name === "double_click" ? 2 : name === "triple_click" ? 3 : 1
        if (input.coordinate !== undefined) {
          const [x, y] = coordinates(input.coordinate, 2)
          await this.display.moveMouse(...this.toScreen(x!, y!))
        }
        await this.withModifiers(modifiers(input.text), () =>
          this.display.click(button, clicks)
        )
        return { content: "OK" }
      }

      case "left_click_drag": {
        const [sx, sy] = coordinates(input.start_coordinate, 2)
        const [ex, ey] = coordinates(input.coordinate, 2)
        await this.withModifiers(modifiers(input.text), async () => {
          await this.display.moveMouse(...this.toScreen(sx!, sy!))
          await this.display.mouseDown()
          await this.display.moveMouse(...this.toScreen(ex!, ey!))
          await this.display.mouseUp()
        })
        return { content: "OK" }
      }

      case "mouse_move": {
        const [x, y] = coordinates(input.coordinate, 2)
        await this.display.moveMouse(...this.toScreen(x!, y!))
        return { content: "OK" }
      }

      case "left_mouse_down":
        await this.display.mouseDown()
        return { content: "OK" }

      case "left_mouse_up":
        await this.display.mouseUp()
        return { content: "OK" }

      case "cursor_position": {
        const { x, y } = await this.display.cursorPosition()
        // Report back in the model's coordinate space, not the screen's.
        return {
          content: `X=${Math.round(x * this.scale)},Y=${Math.round(y * this.scale)}`,
        }
      }

      case "scroll": {
        const direction = String(input.scroll_direction ?? "down")
        if (!["up", "down", "left", "right"].includes(direction)) {
          return { content: `Unknown scroll_direction "${direction}".`, isError: true }
        }
        if (input.coordinate !== undefined) {
          const [x, y] = coordinates(input.coordinate, 2)
          await this.display.moveMouse(...this.toScreen(x!, y!))
        }
        await this.withModifiers(modifiers(input.text), () =>
          this.display.scroll(
            direction as "up" | "down" | "left" | "right",
            Number(input.scroll_amount ?? 3)
          )
        )
        return { content: "OK" }
      }

      case "type":
        await this.display.typeText(String(input.text ?? ""))
        return { content: "OK" }

      case "key":
        await this.display.pressKey(
          String(input.text ?? ""),
          clamp(Number(input.repeat ?? 1), 1, 100)
        )
        return { content: "OK" }

      case "hold_key": {
        const chord = String(input.text ?? "")
        await this.display.keyDown(chord)
        try {
          await sleep(clamp(Number(input.duration ?? 0), 0, 300) * 1000)
        } finally {
          await this.display.keyUp(chord)
        }
        return { content: "OK" }
      }

      case "wait":
        await sleep(clamp(Number(input.duration ?? 0), 0, 300) * 1000)
        return { content: "OK" }

      default:
        return {
          content: `Unknown computer member "${name}".`,
          isError: true,
        }
    }
  }

  /**
   * Capture, optionally crop to a region, downscale to the configured budget,
   * and remember the scale factor so later coordinates can be converted back.
   */
  private async capture(
    region?: [number, number, number, number]
  ): Promise<ToolsetOutcome> {
    const shot = await this.display.screenshot()
    let png = shot.png
    let width = shot.width
    let height = shot.height

    if (region) {
      // The region arrives in the previous screenshot's (scaled) coordinates.
      const [x0, y0, x1, y1] = region.map((value) =>
        Math.round(value / this.scale)
      ) as [number, number, number, number]
      const cropWidth = Math.max(1, x1 - x0)
      const cropHeight = Math.max(1, y1 - y0)
      png = await cropPng(png, x0, y0, cropWidth, cropHeight)
      width = cropWidth
      height = cropHeight
      // A zoom is returned at full resolution, so it defines no new scale.
    } else {
      const longEdge = Math.max(width, height)
      if (longEdge > this.maxLongEdge) {
        const ratio = this.maxLongEdge / longEdge
        png = await resizePng(png, Math.round(width * ratio))
        this.scale = ratio
      } else {
        this.scale = 1
      }
    }

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
      ],
    }
  }

  /**
   * Hold the given modifier keys for the duration of an action, releasing them
   * in reverse order even if the action throws.
   */
  private async withModifiers(
    mods: string[],
    action: () => Promise<void>
  ): Promise<void> {
    for (const modifier of mods) await this.display.keyDown(modifier)
    try {
      await action()
    } finally {
      for (const modifier of [...mods].reverse()) {
        await this.display.keyUp(modifier)
      }
    }
  }

  /** Model (screenshot) pixels -> real screen pixels. */
  private toScreen(x: number, y: number): [number, number] {
    return [Math.round(x / this.scale), Math.round(y / this.scale)]
  }
}

function coordinates(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`Expected an array of ${length} numbers, got ${JSON.stringify(value)}`)
  }
  return value.map((entry) => {
    const numeric = Number(entry)
    if (!Number.isFinite(numeric)) {
      throw new Error(`Non-numeric coordinate ${JSON.stringify(entry)}`)
    }
    return numeric
  })
}

function modifiers(value: unknown): string[] {
  if (typeof value !== "string" || !value) return []
  return value.split("+").map((part) => part.trim()).filter(Boolean)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* -------------------------------------------------------------------------- */
/* Reference display: X11 through xdotool and ImageMagick                      */
/* -------------------------------------------------------------------------- */

export interface X11DisplayOptions {
  /** X display to drive, e.g. ":1". Defaults to $DISPLAY. */
  display?: string
  /** Milliseconds xdotool waits between synthesised keystrokes. */
  typeDelayMs?: number
}

/**
 * Drives a Linux X session with `xdotool` for input and ImageMagick's `import`
 * for capture.
 *
 * Run this against a throwaway VM or container with the narrowest privileges
 * and a domain allowlist for egress. Anything on that screen is untrusted input
 * to the model: the API flags likely prompt injection in screenshots, but the
 * isolation is yours to provide.
 */
export class X11Display implements ComputerDisplay {
  private readonly env: NodeJS.ProcessEnv
  private readonly typeDelayMs: number

  constructor(options: X11DisplayOptions = {}) {
    this.env = {
      ...process.env,
      ...(options.display ? { DISPLAY: options.display } : {}),
    }
    this.typeDelayMs = options.typeDelayMs ?? 12
  }

  async screenshot(): Promise<{ png: Buffer; width: number; height: number }> {
    const dir = await mkdtemp(join(tmpdir(), "claude-shot-"))
    const file = join(dir, "screen.png")
    try {
      await this.exec("import", ["-window", "root", "-silent", file])
      const png = await readFile(file)
      const { width, height } = await pngSize(png)
      return { png, width, height }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.exec("xdotool", ["mousemove", "--sync", String(x), String(y)])
  }

  async click(button: "left" | "right" | "middle", clicks: number): Promise<void> {
    const code = button === "left" ? "1" : button === "middle" ? "2" : "3"
    await this.exec("xdotool", ["click", "--repeat", String(clicks), code])
  }

  async mouseDown(): Promise<void> {
    await this.exec("xdotool", ["mousedown", "1"])
  }

  async mouseUp(): Promise<void> {
    await this.exec("xdotool", ["mouseup", "1"])
  }

  async cursorPosition(): Promise<{ x: number; y: number }> {
    const { stdout } = await this.exec("xdotool", ["getmouselocation", "--shell"])
    const x = /X=(-?\d+)/.exec(stdout)?.[1]
    const y = /Y=(-?\d+)/.exec(stdout)?.[1]
    return { x: Number(x ?? 0), y: Number(y ?? 0) }
  }

  async scroll(
    direction: "up" | "down" | "left" | "right",
    amount: number
  ): Promise<void> {
    const button = { up: "4", down: "5", left: "6", right: "7" }[direction]
    await this.exec("xdotool", [
      "click",
      "--repeat",
      String(Math.max(1, Math.round(amount))),
      button,
    ])
  }

  async typeText(text: string): Promise<void> {
    await this.exec("xdotool", [
      "type",
      "--delay",
      String(this.typeDelayMs),
      "--",
      text,
    ])
  }

  async pressKey(chord: string, repeat: number): Promise<void> {
    // "Backspace Backspace" is several presses; "ctrl+s" is one chord.
    const chords = chord.split(/\s+/).filter(Boolean)
    for (let i = 0; i < repeat; i++) {
      for (const single of chords) {
        await this.exec("xdotool", ["key", "--clearmodifiers", single])
      }
    }
  }

  async keyDown(key: string): Promise<void> {
    await this.exec("xdotool", ["keydown", key])
  }

  async keyUp(key: string): Promise<void> {
    await this.exec("xdotool", ["keyup", key])
  }

  private async exec(command: string, args: string[]) {
    try {
      return await run(command, args, { env: this.env, maxBuffer: 64 * 1024 * 1024 })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        throw new Error(
          `${command} is not installed. X11Display needs xdotool and ImageMagick ` +
            `(apt-get install xdotool imagemagick).`
        )
      }
      throw error
    }
  }
}

async function cropPng(
  png: Buffer,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<Buffer> {
  return imagemagick(png, ["-crop", `${width}x${height}+${x}+${y}`, "+repage"])
}

async function resizePng(png: Buffer, width: number): Promise<Buffer> {
  return imagemagick(png, ["-resize", `${width}x`])
}

/** Pipe a PNG through ImageMagick without touching the filesystem. */
function imagemagick(png: Buffer, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "convert",
      ["png:-", ...args, "png:-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          reject(
            code === "ENOENT"
              ? new Error("ImageMagick `convert` is not installed.")
              : error
          )
          return
        }
        resolve(stdout as unknown as Buffer)
      }
    )
    child.stdin?.end(png)
  })
}

/** Read width and height straight out of the PNG IHDR chunk. */
async function pngSize(png: Buffer): Promise<{ width: number; height: number }> {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) {
    throw new Error("Screenshot is not a PNG.")
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
