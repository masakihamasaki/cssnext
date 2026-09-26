// Run with: node --test higgsfield/
var test = require("node:test")
var assert = require("node:assert")
var agent = require("./agent")
var cli = require("./cli")

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: function() {
      return Promise.resolve(body === undefined ? "" : JSON.stringify(body))
    },
  }
}

// Fake fetch: replies in order and records every call.
function fakeFetch(replies) {
  var calls = []
  var fn = function(url, init) {
    calls.push({url: url, init: init})
    var next = replies.shift()
    if (!next) {
      throw new Error("unexpected request " + init.method + " " + url)
    }
    return Promise.resolve(typeof next === "function" ? next(url, init) : next)
  }
  fn.calls = calls
  return fn
}

function makeClient(replies) {
  var fetch = fakeFetch(replies)
  var sleeps = []
  var client = new agent.AgentClient({
    apiKey: "id:secret",
    fetch: fetch,
    sleep: function(ms) {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })
  return {client: client, fetch: fetch, sleeps: sleeps}
}

function assistant(status, text) {
  return {
    message_id: "a1",
    role: "assistant",
    status: status,
    message: {parts: [{type: "reasoning"}, {type: "text", text: text}]},
  }
}

test("credentials come from HF_KEY or HF_API_KEY + HF_API_SECRET", function() {
  assert.equal(agent.getCredentialKey({HF_KEY: "a:b"}), "a:b")
  assert.equal(
    agent.getCredentialKey({HF_API_KEY: "a", HF_API_SECRET: "b"}), "a:b"
  )
  assert.throws(function() {
    agent.getCredentialKey({})
  }, agent.AgentError)
})

test("createSession posts config with Key auth", async function() {
  var t = makeClient([jsonResponse(200, {session_id: "s1", status: "idle"})])
  var session = await t.client.createSession()
  assert.deepEqual(session, {sessionId: "s1", status: "idle"})
  var call = t.fetch.calls[0]
  assert.equal(call.url, "https://api.higgsfield.ai/v1/agent/sessions")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.headers.Authorization, "Key id:secret")
  assert.deepEqual(JSON.parse(call.init.body), {config: {}})
})

test("run polls with backoff until a terminal reply", async function() {
  var t = makeClient([
    jsonResponse(200, {message_id: "u1"}),
    jsonResponse(200, {status: "processing", messages: []}),
    jsonResponse(200, {
      status: "processing",
      messages: [assistant("processing", "")],
    }),
    jsonResponse(200, {
      status: "idle",
      messages: [assistant("completed",
        "Done: https://cdn.example/a.png. Also https://cdn.example/a.png")],
    }),
  ])
  var result = await t.client.run("s1", "make an image")
  assert.equal(result.status, "completed")
  assert.deepEqual(result.assetUrls, ["https://cdn.example/a.png"])
  assert.deepEqual(t.sleeps, [2000, 3000, 4500])
  assert.equal(
    t.fetch.calls[1].url,
    "https://api.higgsfield.ai/v1/agent/sessions/s1/messages?after=u1"
  )
})

test("run answers clarifying questions via onQuestion", async function() {
  var asked = []
  var t = makeClient([
    jsonResponse(200, {message_id: "u1"}),
    jsonResponse(200, {
      status: "awaiting_input",
      messages: [assistant("processing", "Which style?")],
    }),
    jsonResponse(200, {message_id: "u2"}),
    jsonResponse(200, {
      status: "idle",
      messages: [assistant("completed", "ok")],
    }),
  ])
  var result = await t.client.run("s1", "task", {
    onQuestion: function(q) {
      asked.push(q)
      return "Photorealistic"
    },
  })
  assert.deepEqual(asked, ["Which style?"])
  assert.equal(JSON.parse(t.fetch.calls[2].init.body).content,
    "Photorealistic")
  assert.match(t.fetch.calls[3].url, /after=u2$/)
  assert.equal(result.status, "completed")
})

test("run without handler returns awaiting_input", async function() {
  var t = makeClient([
    jsonResponse(200, {message_id: "u1"}),
    jsonResponse(200, {
      status: "awaiting_input",
      messages: [assistant("processing", "Which style?")],
    }),
  ])
  var result = await t.client.run("s1", "task")
  assert.equal(result.status, "awaiting_input")
  assert.equal(result.text, "Which style?")
})

test("run times out locally without resending", async function() {
  var now = 0
  var fetch = fakeFetch([
    jsonResponse(200, {message_id: "u1"}),
    jsonResponse(200, {status: "processing", messages: []}),
  ])
  var client = new agent.AgentClient({
    apiKey: "k",
    fetch: fetch,
    now: function() {
      return now
    },
    // real clocks keep moving, even across a 0ms sleep
    sleep: function(ms) {
      now += ms + 1
      return Promise.resolve()
    },
  })
  await assert.rejects(client.run("s1", "t", {timeout: 1000}),
    agent.AgentTimeoutError)
  assert.equal(fetch.calls.length, 2)
})

test("HTTP errors map to typed errors", async function() {
  var cases = [
    [403, agent.AgentAccessDeniedError],
    [402, agent.InsufficientCreditsError],
    [409, agent.SessionBusyError],
    [503, agent.AgentBackendError],
    [400, agent.AgentError],
  ]
  for (var i = 0; i < cases.length; i++) {
    var t = makeClient([jsonResponse(cases[i][0], {detail: "x"})])
    await assert.rejects(t.client.createSession(), cases[i][1])
  }
})

test("upload: slot, presigned PUT without auth, confirm", async function() {
  var t = makeClient([
    jsonResponse(200, {
      id: "m1",
      upload_url: "https://upload.example/put",
      content_type: "image/jpeg",
      url: "https://cdn.example/m1.jpeg",
    }),
    jsonResponse(200),
    jsonResponse(200, {status: "uploaded"}),
  ])
  var url = await t.client.upload(Buffer.from("x"), "jpeg", "image")
  assert.equal(url, "https://cdn.example/m1.jpeg")
  var put = t.fetch.calls[1]
  assert.equal(put.url, "https://upload.example/put")
  assert.equal(put.init.headers.Authorization, undefined)
  assert.equal(put.init.headers["Content-Type"], "image/jpeg")
  assert.match(t.fetch.calls[2].url, /\/v1\/agent\/media\/m1\/confirm$/)
})

test("cli parses options and media types", function() {
  var opts = cli.parseArgs(
    ["--session", "s1", "--json", "animate", "this", "--file", "a.mp4"]
  )
  assert.equal(opts.session, "s1")
  assert.equal(opts.json, true)
  assert.equal(opts.file, "a.mp4")
  assert.equal(opts.task, "animate this")
  assert.equal(cli.mediaType("mp4"), "video")
  assert.equal(cli.mediaType("pdf"), "file")
})
