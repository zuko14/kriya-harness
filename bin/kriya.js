#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { handoff, HandoffError, pull } from "../plugins/kriya-handoff/index.js"
import { KriyaError, revokeDevice } from "../src/api.js"
import { doctor, nodeOk } from "../src/doctor.js"
import { runDsh } from "../src/launch.js"
import { serve, servedFolder, ServeError } from "../src/world.js"
import { login } from "../src/login.js"
import { CLIENT_VERSION, DSH_VERSION, kriyaHome } from "../src/paths.js"
import { deleteDevice, ensureHome, kriyaUrl, readDevice } from "../src/store.js"

// `kriya`: the Kriya Harness command (DSH_DISTRIBUTION §2). It signs in,
// picks a Kriya profile and hands over to DSH's own launcher.

const HELP = `Kriya Harness (beta)

Usage:
  kriya login [--url <your Kriya address>] [--no-browser]
  kriya [--no-open] [--port <n>]
                        open the agent in your browser (local, 127.0.0.1)
  kriya run "<job>"     run one job and print the answer (--json for events)
  kriya acp             the agent for editors: an ACP server on stdin/stdout
                        (your editor starts it; kriya acp --help for details)
  kriya handoff ["<note>"]
                        hand this repository's uncommitted work to your Kriya
                        agent in a cloud workspace (HEAD must be on GitHub)
  kriya pull [<workspace id>]
                        bring a workspace's changes back on a new branch
                        kriya/pull-<id> (default: your last handoff)
  kriya serve [folder]  let your Kriya agents work on this machine: cloud tasks
                        run commands and change files in new subfolders of
                        <folder> (default: this folder) while it runs
  kriya doctor          check this machine, the sign-in and the gateway
  kriya logout          sign this device out
  kriya --version

Run it in a folder you can afford to change; see SAFETY.md.`

const ACP_HELP = `kriya acp: the Kriya Harness agent for editors that speak the Agent Client
Protocol (ACP v1). The editor starts it and talks over stdin/stdout; stdout
carries only protocol frames, messages go to stderr. It's the same agent as
\`kriya\`: Kriya's models, skills and memory tools, phone approvals and the
mirror, with the same permission defaults. Sign in first with kriya login.

In your editor's agent settings, use the command:  kriya acp`

const NOTICE = `Kriya Harness is a beta built on DeepSeek Harness, a developer preview that
hasn't had a security audit. The agent can read and change files and run
commands on this machine, starting in the folder you open it in. Use a
folder you can afford to lose, keep backups, and read SAFETY.md.
`

const SERVE_NOTICE = `kriya serve lets your Kriya agents' cloud tasks run commands and change
files on this machine, as you, with your network: there is no sandbox. They
work only in new subfolders of the folder you serve, but a command can reach
anything you can. Serve a folder on a machine you can afford to change, and
stop with Ctrl-C when you're done.
`

const say = (line) => process.stdout.write(`${line}\n`)

function firstRunNotice() {
  ensureHome()
  const marker = join(kriyaHome(), ".notice-shown")
  if (existsSync(marker)) return
  process.stderr.write(`${NOTICE}\n`)
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

// The workspace of the last handoff from this machine, for a bare `kriya pull`
const lastWorkspace = () => join(kriyaHome(), "last-workspace")

function option(args, name) {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}

function signedIn() {
  const device = readDevice()
  if (!device) {
    say("Run `kriya login` to connect your Kriya account.")
    process.exit(1)
  }
  return device
}

async function main(argv) {
  const [command, ...args] = argv
  if (command === "--version" || command === "-v") {
    say(`kriya ${CLIENT_VERSION} (Kriya Harness beta, built on DeepSeek Harness ${DSH_VERSION})`)
    return 0
  }
  if (command === "--help" || command === "-h" || command === "help") {
    say(HELP)
    return 0
  }
  if (!nodeOk()) {
    say(`Kriya Harness needs Node 24.9 or later; this is ${process.versions.node}.`)
    return 1
  }
  firstRunNotice()

  switch (command) {
    case "login": {
      const given = option(args, "--url") ?? process.env.KRIYA_URL ?? readDevice()?.url
      if (!given) {
        say("Which Kriya? Run `kriya login --url https://<your Kriya address>`.")
        return 1
      }
      const browser = !args.includes("--no-browser")
      await login(kriyaUrl(given), { browser })
      return 0
    }
    case "logout": {
      const device = readDevice()
      if (!device) {
        say("Not signed in.")
        return 0
      }
      try {
        await revokeDevice(device.url, device.token)
      } catch (error) {
        // Signed out here either way; the person can revoke it in Account → Devices
        if (!(error instanceof KriyaError) || error.status !== 401)
          say(`Couldn't tell Kriya (${error.message}); revoke this device in Account → Devices.`)
      }
      deleteDevice()
      say("Signed out.")
      return 0
    }
    case "doctor":
      return (await doctor()) ? 0 : 1
    case "handoff": {
      const device = signedIn()
      const done = await handoff(device, process.cwd(), args.join(" "))
      writeFileSync(lastWorkspace(), `${done.workspaceId}\n`)
      say(`Handed off (${done.bytes} bytes of changes). Your agent carries on in Kriya:`)
      say(`  ${done.url}`)
      say(`Workspace ${done.workspaceId}; bring its changes back with kriya pull.`)
      return 0
    }
    case "pull": {
      const device = signedIn()
      const id = args[0] ?? (existsSync(lastWorkspace()) ? readFileSync(lastWorkspace(), "utf8").trim() : "")
      if (!id) {
        say("Which workspace? Run kriya pull <workspace id>.")
        return 1
      }
      const done = await pull(device, process.cwd(), id)
      say(`On branch ${done.branch}: the workspace's changes on ${done.baseSha.slice(0, 12)} (${done.bytes} bytes).`)
      say("Review them with git diff HEAD, then commit or merge as you like.")
      return 0
    }
    case "serve": {
      if (args.length > 1 || args[0]?.startsWith("-")) {
        say("Usage: kriya serve [folder]")
        return 1
      }
      const device = signedIn()
      const folder = await servedFolder(args[0] ?? process.cwd())
      process.stderr.write(`${SERVE_NOTICE}\n`)
      const stop = new AbortController()
      process.once("SIGINT", () => stop.abort())
      process.once("SIGTERM", () => stop.abort())
      await serve({ device, folder, say, signal: stop.signal })
      say("Stopped serving.")
      return 0
    }
    case "run": {
      const device = signedIn()
      return runDsh("kriya-run", args, device)
    }
    case "acp": {
      // Stdout carries only ACP frames (newline-delimited JSON-RPC), so
      // everything kriya itself says goes to stderr. DSH's ACP app takes no
      // options but --help; the transport is stdio, the editor's choice
      const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h")
      if (args.length && !help) {
        process.stderr.write(`kriya acp takes no options but --help.\n`)
        return 1
      }
      if (help) {
        say(ACP_HELP)
        return 0
      }
      const device = readDevice()
      if (!device) {
        process.stderr.write("kriya: run `kriya login` to connect your Kriya account.\n")
        return 1
      }
      return runDsh("kriya-acp", [], device)
    }
    case undefined:
    case "--no-open":
    case "--port": {
      // Only these Web UI flags pass through; never --host, so the UI stays on 127.0.0.1
      const flags = command === undefined ? [] : [command, ...args]
      const port = option(flags, "--port")
      if (port !== undefined && !/^\d{2,5}$/.test(port)) {
        say("--port takes a number, e.g. --port 8080.")
        return 1
      }
      if (flags.some((flag) => flag !== "--no-open")) {
        say(`Unknown option ${flags.find((flag) => flag !== "--no-open")}.\n\n${HELP}`)
        return 1
      }
      const device = signedIn()
      return runDsh("kriya", [...flags, ...(port ? ["--port", port] : [])], device)
    }
    default:
      say(`Unknown command ${command}.\n\n${HELP}`)
      return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    const known = error instanceof KriyaError || error instanceof HandoffError || error instanceof ServeError
    process.stderr.write(`kriya: ${known ? error.message : error?.message ?? error}\n`)
    process.exit(1)
  }
)
