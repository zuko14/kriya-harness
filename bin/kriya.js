#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { KriyaError, revokeDevice } from "../src/api.js"
import { doctor, nodeOk } from "../src/doctor.js"
import { runDsh } from "../src/launch.js"
import { login } from "../src/login.js"
import { CLIENT_VERSION, DSH_VERSION, kriyaHome } from "../src/paths.js"
import { deleteDevice, ensureHome, kriyaUrl, readDevice } from "../src/store.js"

// `kriya`: the Kriya Harness command (DSH_DISTRIBUTION §2). It signs in,
// picks a Kriya profile and hands over to DSH's own launcher.

const HELP = `Kriya Harness (beta), built on DeepSeek Harness

Usage:
  kriya login [--url <your Kriya address>] [--no-browser]
  kriya [--no-open] [--port <n>]
                        open the agent in your browser (local, 127.0.0.1)
  kriya run "<job>"     run one job and print the answer (--json for events)
  kriya doctor          check this machine, the sign-in and the gateway
  kriya logout          sign this device out
  kriya --version

Run it in a folder you can afford to change; see SAFETY.md.`

const NOTICE = `Kriya Harness is a beta built on DeepSeek Harness, a developer preview that
hasn't had a security audit. The agent can read and change files and run
commands on this machine, starting in the folder you open it in. Use a
folder you can afford to lose, keep backups, and read SAFETY.md.
`

const say = (line) => process.stdout.write(`${line}\n`)

function firstRunNotice() {
  ensureHome()
  const marker = join(kriyaHome(), ".notice-shown")
  if (existsSync(marker)) return
  process.stderr.write(`${NOTICE}\n`)
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

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
    case "run": {
      const device = signedIn()
      return runDsh("kriya-run", args, device)
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
    process.stderr.write(`kriya: ${error instanceof KriyaError ? error.message : error?.message ?? error}\n`)
    process.exit(1)
  }
)
