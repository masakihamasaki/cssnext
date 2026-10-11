/**
 * Computer use: several actions per turn against a real desktop.
 *
 *   DISPLAY=:1 node --experimental-strip-types examples/03-computer.ts "open the text editor and type hello"
 *
 * Needs an X server the process can reach, plus `xdotool` and ImageMagick.
 * Point DISPLAY at a throwaway VM or container -- never at your own session:
 * everything on that screen becomes untrusted input to the model.
 */
import { MODEL } from "../src/client.ts"
import { log } from "../src/log.ts"
import { ComputerExecutor, X11Display } from "../src/toolsets/computer.ts"
import { runToolsetAgent } from "../src/toolsets/loop.ts"

const TASK =
  process.argv.slice(2).join(" ") ||
  "Take a screenshot and describe what application is on screen."

async function main(): Promise<void> {
  if (!process.env.DISPLAY) {
    throw new Error("Set DISPLAY to the X display you want the agent to drive.")
  }

  const executor = new ComputerExecutor({
    display: new X11Display(),
    // 1080p is the usual balance of accuracy against image-token cost; 1366 or
    // 1280 are cheaper if the run does not need fine detail.
    maxLongEdge: 1920,
    configs: {
      // Zoom is on by default in this toolset version. Turning it off saves
      // tokens on runs where the model never needs to read small text.
      zoom: { enabled: true },
    },
  })

  log.step(`${MODEL} driving ${process.env.DISPLAY}`)
  log.detail(TASK)

  try {
    const result = await runToolsetAgent({
      prompt: TASK,
      executors: [executor],
      system:
        "You are operating a Linux desktop. Batch the actions of a single step " +
        "into one turn -- click, type, then screenshot -- rather than pausing " +
        "for a round trip between each one. Stop and say so if a screen asks " +
        "for credentials or payment details.",
      maxTurns: 20,
      onText: (text) => log.say(text),
    })

    log.detail(
      `${result.turns} turn(s), ${result.usage.inputTokens} in / ` +
        `${result.usage.outputTokens} out, stopped on ${result.stopReason}`
    )
  } finally {
    await executor.close()
  }
}

await main()
