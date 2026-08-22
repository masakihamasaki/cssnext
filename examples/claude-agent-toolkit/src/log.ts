const DIM = "[2m"
const BOLD = "[1m"
const RESET = "[0m"

const useColor = process.stderr.isTTY && !process.env.NO_COLOR

function paint(code: string, message: string): string {
  return useColor ? `${code}${message}${RESET}` : message
}

export const log = {
  /** A milestone in the script. Goes to stderr so stdout stays pipeable. */
  step(message: string): void {
    process.stderr.write(`${paint(BOLD, "> " + message)}\n`)
  },
  /** Sub-detail of the current step. */
  detail(message: string): void {
    process.stderr.write(`${paint(DIM, "  " + message)}\n`)
  },
  /** Actual program output. */
  say(message: string): void {
    process.stdout.write(`${message}\n`)
  },
}
