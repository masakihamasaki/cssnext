#!/usr/bin/env node
/**
 * Run one Higgsfield agent turn from the terminal.
 *
 *   node higgsfield/cli.js "Generate an alpine lake at sunrise, 4:3"
 *   node higgsfield/cli.js --session <id> "Now a 16:9 version at dusk"
 *   node higgsfield/cli.js --file ./photo.jpg "Animate this into a 5s clip"
 *
 * Options:
 *   --session <id>   continue an existing session (memory persists)
 *   --file <path>    upload an input file; its URL is appended to the task
 *   --answer <text>  auto-answer clarifying questions (else asks on a TTY)
 *   --timeout <sec>  local wait limit per turn (default 1800)
 *   --json           print the result as JSON
 */

var fs = require("fs")
var path = require("path")
var readline = require("readline")
var agent = require("./agent")

var MEDIA_TYPES = {
  image: ["jpg", "jpeg", "png", "webp", "gif"],
  video: ["mp4", "mov", "webm"],
  audio: ["mp3", "wav", "m4a", "ogg"],
}

function parseArgs(argv) {
  var opts = {task: []}
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i]
    if (arg === "--json" || arg === "-h" || arg === "--help") {
      opts[arg.replace(/^-+/, "")] = true
    }
    else if (/^--(session|file|answer|timeout)$/.test(arg)) {
      if (i + 1 >= argv.length) {
        throw new Error(arg + " needs a value")
      }
      opts[arg.slice(2)] = argv[++i]
    }
    else {
      opts.task.push(arg)
    }
  }
  opts.task = opts.task.join(" ").trim()
  return opts
}

function mediaType(extension) {
  for (var type in MEDIA_TYPES) {
    if (MEDIA_TYPES[type].indexOf(extension) !== -1) {
      return type
    }
  }
  return "file"
}

function ask(question) {
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  return new Promise(function(resolve) {
    rl.question("\n[agent asks] " + question + "\n> ", function(answer) {
      rl.close()
      resolve(answer)
    })
  })
}

async function main(argv) {
  var opts = parseArgs(argv)
  if (opts.help || !opts.task) {
    process.stderr.write(fs.readFileSync(__filename, "utf8")
      .split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "")
      .replace(/^ \* ?/gm, "") + "\n")
    return opts.help ? 0 : 2
  }

  var client = new agent.AgentClient()
  var sessionId = opts.session
  if (!sessionId) {
    sessionId = (await client.createSession()).sessionId
    process.stderr.write("session: " + sessionId + "\n")
  }

  var task = opts.task
  if (opts.file) {
    var extension = path.extname(opts.file).slice(1).toLowerCase()
    var url = await client.upload(
      fs.readFileSync(opts.file), extension, mediaType(extension)
    )
    task += " " + url
  }

  var onQuestion
  if (opts.answer) {
    onQuestion = function() {
      return opts.answer
    }
  }
  else if (process.stdin.isTTY) {
    onQuestion = ask
  }

  process.stderr.write("running turn...\n")
  var result = await client.run(sessionId, task, {
    onQuestion: onQuestion,
    timeout: opts.timeout ? Number(opts.timeout) * 1000 : undefined,
  })

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      sessionId: sessionId,
      status: result.status,
      text: result.text,
      assetUrls: result.assetUrls,
    }, null, 2) + "\n")
  }
  else {
    process.stdout.write(result.text + "\n")
    result.assetUrls.forEach(function(u) {
      process.stdout.write("asset: " + u + "\n")
    })
    process.stderr.write("status: " + result.status +
      " (continue with --session " + sessionId + ")\n")
  }
  return result.status === "failed" ? 1 : 0
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function(code) {
    process.exitCode = code
  }, function(err) {
    process.stderr.write((err.name || "Error") + ": " + err.message + "\n")
    process.exitCode = 1
  })
}

module.exports = {parseArgs: parseArgs, mediaType: mediaType, main: main}
