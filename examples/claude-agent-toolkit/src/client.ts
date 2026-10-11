import Anthropic from "@anthropic-ai/sdk"

/**
 * A single shared client.
 *
 * The zero-argument constructor resolves credentials from the environment in
 * this order: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then the profile
 * written by `ant auth login`. There is nothing to configure here if you have
 * already logged in with the CLI.
 */
export const client = new Anthropic()

/**
 * Every surface used in this package (computer use, the browser tool, the Skills
 * API, the Files API) is generally available as of 2026-08-21 and needs no
 * `anthropic-beta` header, so all calls go through the plain `client.messages`,
 * `client.files` and `client.skills` namespaces rather than `client.beta.*`.
 */
export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5"

/**
 * The toolsets below are served on Claude Fable 5, Claude Mythos 5, Claude
 * Opus 5, Claude Sonnet 5 and Claude Opus 4.8. Older models need the previous
 * single-tool `computer_20251124` shape behind a beta header, which this package
 * deliberately does not implement.
 */
export const TOOLSET_MODELS = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
]

export function assertToolsetModel(model: string): void {
  if (!TOOLSET_MODELS.includes(model)) {
    throw new Error(
      `${model} does not serve computer_toolset_20260801 / browser_toolset_20260801. ` +
        `Use one of: ${TOOLSET_MODELS.join(", ")}.`
    )
  }
}

/** The newest code execution tool version. No beta header required. */
export const CODE_EXECUTION_TOOL = {
  type: "code_execution_20260521",
  name: "code_execution",
} as const
