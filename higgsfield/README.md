# Higgsfield integration

Two pieces, independent of the cssnext build:

1. **Claude Code plugin** (optional) — the official
   [`higgsfield-ai/skills`](https://github.com/higgsfield-ai/skills) give
   `/higgsfield:generate`, `/higgsfield:soul-id`, `/higgsfield:websites`, etc.
   Install inside Claude Code:
   ```
   /plugin marketplace add higgsfield-ai/skills
   /plugin install higgsfield@higgsfield
   ```
   Those skills drive the [`higgsfield` CLI](https://github.com/higgsfield-ai/cli)
   (`npm install -g @higgsfield/cli && higgsfield auth login`).
2. **Agent API client** — `agent.js` / `cli.js`, a zero-dependency Node 18+
   port of the Python SDK's `client.agents` (higgsfield-ai/higgsfield-client).

## Agent API

The agent runs multi-step creative tasks (generate, edit, animate…) in durable
sessions that remember earlier turns. Requires an API key with Agent API access
(ask support@higgsfield.ai) and enough credits.

```bash
export HF_KEY="KEY_ID:KEY_SECRET"   # or HF_API_KEY + HF_API_SECRET

node higgsfield/cli.js "Generate an alpine lake at sunrise, editorial, 4:3"
node higgsfield/cli.js --session <id> "Now a 16:9 version at dusk"
node higgsfield/cli.js --file ./photo.jpg "Animate this into a 5s clip"
node higgsfield/cli.js --answer "Photorealistic" --json "Make a poster"
```

From code:

```js
var AgentClient = require("./higgsfield/agent").AgentClient
var client = new AgentClient()
var session = await client.createSession()
var result = await client.run(session.sessionId, "Generate a lake image", {
  onQuestion: function(question) { return "Photorealistic" },
})
result.status     // "completed" | "failed" | "awaiting_input"
result.text       // the agent's answer
result.assetUrls  // generated asset URLs
```

Behavior matches the official SDK:

- `run()` sends the task, then polls `GET /v1/agent/sessions/{id}/messages
  ?after=<message_id>` with 2s → 10s backoff; default local limit 30 min.
- Clarifying questions are answered via `onQuestion`; without it the turn
  returns `awaiting_input` — answer with another `run()` on the same session.
- Mutating calls are never retried, so a timeout never submits a second
  billable turn (the server-side turn keeps running).
- Errors: `AgentAccessDeniedError` (403), `InsufficientCreditsError` (402),
  `SessionBusyError` (409), `AgentBackendError` (5xx), `AgentTimeoutError`.
- `upload()` gets a presigned slot, PUTs the bytes, confirms, and returns a
  CDN URL to reference in the task text.

Tests (mocked HTTP): `node --test higgsfield/agent.test.js`
