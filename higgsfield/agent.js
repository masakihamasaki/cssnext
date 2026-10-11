/**
 * Minimal Higgsfield Agent API client (Node 18+, zero dependencies).
 *
 * Mirrors the official Python SDK (higgsfield-ai/higgsfield-client,
 * `client.agents`): durable sessions, one autonomous turn per message,
 * clarifying questions, and media uploads.
 *
 * Credentials: HF_KEY ("KEY_ID:KEY_SECRET"), or HF_API_KEY + HF_API_SECRET.
 * Agent API access must be enabled for the key (support@higgsfield.ai).
 */

var BASE_URL = "https://api.higgsfield.ai"
var POLL_INITIAL = 2000
var POLL_MAX = 10000
var POLL_BACKOFF = 1.5
var DEFAULT_TURN_TIMEOUT = 30 * 60 * 1000
var URL_RE = /https?:\/\/[^\s)\]>"']+/g

class AgentError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
  }
}
class AgentAccessDeniedError extends AgentError {}
class InsufficientCreditsError extends AgentError {}
class SessionBusyError extends AgentError {}
class AgentBackendError extends AgentError {}
class AgentTimeoutError extends AgentError {}

function getCredentialKey(env) {
  env = env || process.env
  if (env.HF_KEY) {
    return env.HF_KEY
  }
  if (env.HF_API_KEY && env.HF_API_SECRET) {
    return env.HF_API_KEY + ":" + env.HF_API_SECRET
  }
  throw new AgentError(
    "Higgsfield API credentials missing. Please set HF_KEY, or " +
    "alternatively set HF_API_KEY and HF_API_SECRET."
  )
}

// Plain text of a transcript row: user rows carry {type: "text", text},
// assistant rows carry {parts: [...]} where only "text" parts are the answer.
function messageText(message) {
  var body = message && message.message
  if (!body || typeof body !== "object") {
    return ""
  }
  if (typeof body.text === "string") {
    return body.text
  }
  if (!Array.isArray(body.parts)) {
    return ""
  }
  return body.parts
    .filter(function(p) {
      return p && p.type === "text" && typeof p.text === "string"
    })
    .map(function(p) {
      return p.text
    })
    .join("\n")
}

function assetUrls(text) {
  var seen = []
  var matches = text.match(URL_RE) || []
  matches.forEach(function(url) {
    url = url.replace(/[.,;]+$/, "")
    if (seen.indexOf(url) === -1) {
      seen.push(url)
    }
  })
  return seen
}

function turnResult(status, message) {
  var text = messageText(message)
  return {
    status: status,
    message: message || null,
    text: text,
    assetUrls: assetUrls(text),
  }
}

function isTerminal(message) {
  return message.status === "completed" || message.status === "failed"
}

// The poll uses after=<user message id>, so every assistant row in the slice
// belongs to this turn. A terminal assistant row wins; a parked session
// (awaiting_input) surfaces the question instead.
function turnOutcome(state) {
  var assistants = (state.messages || []).filter(function(m) {
    return m.role === "assistant"
  })
  for (var i = assistants.length - 1; i >= 0; i--) {
    if (isTerminal(assistants[i])) {
      return turnResult(assistants[i].status, assistants[i])
    }
  }
  if (state.status === "awaiting_input") {
    return turnResult("awaiting_input", assistants[assistants.length - 1])
  }
  return null
}

async function raiseForAgentStatus(response) {
  if (response.ok) {
    return
  }
  var code = response.status
  var raw = await response.text()
  var detail = raw
  try {
    detail = JSON.parse(raw).detail || ""
  }
  catch (e) {
    detail = raw // non-JSON body: keep raw text
  }
  if (code === 403) {
    throw new AgentAccessDeniedError(
      "Agent API is not enabled for your account. " +
      "Contact support@higgsfield.ai to request access.",
      code
    )
  }
  if (code === 402) {
    throw new InsufficientCreditsError("Insufficient credits: " + detail, code)
  }
  if (code === 409) {
    throw new SessionBusyError(
      "A turn is already running on this session. " +
      "Wait for it to finish or interrupt it.",
      code
    )
  }
  if (code >= 500) {
    throw new AgentBackendError(
      "Agent backend unavailable (" + code + "): " + detail,
      code
    )
  }
  throw new AgentError("HTTP " + code + ": " + detail, code)
}

class AgentClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] "KEY_ID:KEY_SECRET"; defaults to env
   * @param {string} [options.baseUrl]
   * @param {Function} [options.fetch] injectable for tests
   * @param {Function} [options.sleep] injectable for tests
   */
  constructor(options) {
    options = options || {}
    this.apiKey = options.apiKey || getCredentialKey(options.env)
    this.baseUrl = (options.baseUrl || BASE_URL).replace(/\/+$/, "")
    this._fetch = options.fetch || globalThis.fetch
    this._sleep = options.sleep || function(ms) {
      return new Promise(function(resolve) {
        setTimeout(resolve, ms)
      })
    }
    this._now = options.now || Date.now
  }

  async _request(method, path, body, query) {
    var url = this.baseUrl + "/v1/agent" + path
    if (query) {
      url += "?" + new URLSearchParams(query).toString()
    }
    var response = await this._fetch(url, {
      method: method,
      headers: {
        "Authorization": "Key " + this.apiKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await raiseForAgentStatus(response)
    var text = await response.text()
    return text ? JSON.parse(text) : null
  }

  // Sessions are durable: keep the id, the agent remembers previous turns.
  async createSession(config) {
    var data = await this._request("POST", "/sessions", {config: config || {}})
    return {sessionId: data.session_id, status: data.status}
  }

  // Submit one message; the turn runs asynchronously. Returns message_id.
  async send(sessionId, content) {
    var data = await this._request(
      "POST",
      "/sessions/" + encodeURIComponent(sessionId) + "/messages",
      {content: content}
    )
    return data.message_id
  }

  async messages(sessionId, after) {
    return this._request(
      "GET",
      "/sessions/" + encodeURIComponent(sessionId) + "/messages",
      undefined,
      after ? {after: after} : undefined
    )
  }

  async interrupt(sessionId) {
    await this._request(
      "POST",
      "/sessions/" + encodeURIComponent(sessionId) + "/interrupt"
    )
  }

  /**
   * Send a message and poll (2s -> 10s backoff) until the turn ends.
   * If the agent asks a question and `onQuestion` is given, its answer is
   * sent and polling continues; otherwise status "awaiting_input" returns.
   * Mutating calls are never retried, so a timeout never re-bills a turn.
   */
  async run(sessionId, content, options) {
    options = options || {}
    var timeout = options.timeout || DEFAULT_TURN_TIMEOUT
    var deadline = this._now() + timeout
    var messageId = await this.send(sessionId, content)
    var delay = POLL_INITIAL
    for (;;) {
      if (this._now() > deadline) {
        throw new AgentTimeoutError(
          "turn did not finish within " + Math.round(timeout / 1000) +
          "s (session " + sessionId + "); it keeps running server-side"
        )
      }
      await this._sleep(Math.min(delay, Math.max(0, deadline - this._now())))
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX)

      var outcome = turnOutcome(await this.messages(sessionId, messageId))
      if (!outcome) {
        continue
      }
      if (outcome.status === "awaiting_input" && options.onQuestion) {
        var answer = await options.onQuestion(outcome.text)
        messageId = await this.send(sessionId, answer)
        delay = POLL_INITIAL
        continue
      }
      return outcome
    }
  }

  /**
   * Upload input bytes; returns the CDN URL to reference in a message.
   * type: image | video | audio | file
   */
  async upload(data, extension, type) {
    type = type || "image"
    var slot = await this._request(
      "POST", "/media", {extension: extension, type: type}
    )
    // Presigned URL: no Higgsfield auth header.
    var put = await this._fetch(slot.upload_url, {
      method: "PUT",
      headers: {"Content-Type": slot.content_type},
      body: data,
    })
    if (!put.ok) {
      throw new AgentError("Upload failed: HTTP " + put.status, put.status)
    }
    var confirm = await this._request(
      "POST",
      "/media/" + encodeURIComponent(slot.id) + "/confirm",
      {type: type}
    )
    if (!confirm || confirm.status !== "uploaded") {
      throw new AgentError(
        "Agent media upload has not been confirmed by the server"
      )
    }
    return slot.url
  }
}

module.exports = {
  AgentClient: AgentClient,
  AgentError: AgentError,
  AgentAccessDeniedError: AgentAccessDeniedError,
  InsufficientCreditsError: InsufficientCreditsError,
  SessionBusyError: SessionBusyError,
  AgentBackendError: AgentBackendError,
  AgentTimeoutError: AgentTimeoutError,
  getCredentialKey: getCredentialKey,
  messageText: messageText,
  assetUrls: assetUrls,
  turnOutcome: turnOutcome,
}
