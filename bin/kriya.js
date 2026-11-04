#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { handoff, HandoffError, pull } from "../plugins/kriya-handoff/index.js"
import { KriyaError, me, revokeDevice } from "../src/api.js"
import { doctor, nodeOk } from "../src/doctor.js"
import { runDsh } from "../src/launch.js"
import { serve, servedFolder, ServeError } from "../src/world.js"
import { HEAVY_CATALOG, linkSkills, SKILL_ROOTS, skillsDir, SkillsError, unlinkSkill, visibleSkills } from "../src/local-skills.js"
import { CheckpointError, listCheckpoints, repoRoot, undo } from "../src/checkpoints.js"
import { clearCheck, confirmCheck, confirmedCheck, discoverChecks, MAX_ATTEMPTS, VerifyError } from "../src/verify.js"
import { projectRoot, setSkillSwitch, SwitchError } from "../src/skill-switches.js"
import { confirmRule, dismissRule, forgetRule, listRules, RulesError } from "../src/rules.js"
import { login } from "../src/login.js"
import { APP_MODES, FULL_ACCESS_WARNING, MODES, ModeError, parseMode, planJob, switchEnv } from "../src/modes.js"
import { CLIENT_VERSION, DSH_VERSION, kriyaHome } from "../src/paths.js"
import { deleteDevice, ensureHome, kriyaUrl, readDevice } from "../src/store.js"

// `kriya`: the Kriya Harness command (DSH_DISTRIBUTION §2). It signs in,
// picks a Kriya profile and hands over to DSH's own launcher.

const HELP = `Kriya Harness (beta)

Usage:
  kriya login [--url <your Kriya address>] [--no-browser]
  kriya [--mode <mode>] [--no-loop] [--loop-v2] [--browser-tools] [--router] [--no-budget] [--anchor] [--no-open] [--port <n>]
                        open the agent in your browser (local, 127.0.0.1)
  kriya run [--mode <mode>] [--no-loop] [--loop-v2] [--browser-tools] [--router] [--no-budget] [--anchor] "<job>"
                        run one job and print the answer (--json for events)
  kriya acp             the agent for editors: an ACP server on stdin/stdout
  kriya usage [--json]  this month's Kriya Harness spend and limit
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
  kriya skills          the SKILL.md skills your agent sees in this folder
  kriya skills link <folder> [--only <a,b>]
                        add a folder of skills (superpowers, ponytail, ECC, your
                        own) to ~/.kriya/skills, as links
  kriya skills unlink <name>
  kriya skills off <name> [--everywhere]
                        take a skill out of the agent's list for this project
                        (or everywhere), so it costs no tokens; nothing is deleted
  kriya skills on <name>
                        remove a linked skill
  kriya verify          this project's check and the ones it defines
  kriya verify use <number> | "<command>"
                        confirm the check the agent runs (the Kriya loop): its exit
                        code alone says whether the work passes
  kriya verify clear    forget this project's check
  kriya undo            put this repository's files back one step (with the loop
                        the agent saves a checkpoint before each change)
  kriya undo --list     the checkpoints, newest first
  kriya undo <number>   go back to one of them; what an undo replaces is kept
  kriya rules           rules the loop proposed from repeated failures, and yours
  kriya rules confirm <number> ["<your wording>"]
                        let the agent see a proposed rule (only you can)
  kriya rules dismiss <number> | forget <number>
  kriya doctor          check this machine, the sign-in and the gateway
  kriya logout          sign this device out
  kriya --version

Modes (--mode; default ask):
${Object.entries(MODES)
  .map(([name, mode]) => `  ${name.padEnd(6)}${mode.what}`)
  .join("\n")}
  In the app, switch with the Permissions control or /permission, and type
  /plan to plan first. plan as a --mode is for kriya run.

The Kriya loop (on; --no-loop turns it off): the agent checks its own work
  with kriya_verify, which runs the check you confirmed (kriya verify use)
  and reports pass, fail, or blocked after ${MAX_ATTEMPTS} failed runs, from the exit
  code alone. Before each change it saves a checkpoint on Kriya's own git
  ref (kriya undo); your branches, index and stash are never touched.

The turn budget (on; --no-budget turns it off): each turn is bounded by
  code: at most 150 steps (KRIYA_MAX_STEPS), 60 minutes (KRIYA_TURN_MINUTES)
  and 10 identical tool calls in a row (KRIYA_MAX_REPEATS). Near a limit the
  agent is told to wrap up; at a limit the turn stops as "blocked" (kriya
  run exits 1). Each step's builder (with the loop) is bounded more tightly:
  40 steps (KRIYA_BUILDER_STEPS), 15 minutes (KRIYA_BUILDER_MINUTES); the
  check still runs on what a stopped builder left.

--loop-v2 (beta, off): plan steps name the steps they need, so one blocked
  step skips only what depends on it; a failed check is classified (syntax,
  type, assertion, environment, timeout) and cut to its failing lines; a
  pass that changed tests must also pass with the committed tests; a worse
  attempt is set aside; a failure seen twice is proposed as a rule.

--browser-tools (beta, off): the agent gets a browser for apps on this computer
  (localhost only), on your installed Google Chrome with its own profile:
  open, read, screenshot, click, type, console and network, to test what it
  builds. The Preview tab shows and drives the same page.

--router (beta, off): for each request, a short brief of the skills
  likely to help and the tools to start with, chosen by code from its
  words; it hides and adds nothing.

--anchor (beta): your own messages are kept word for word where compaction
  never condenses them, so a requirement survives a summary that drops it.

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

// The loop, budget and kept-request switches (src/modes.js switchEnv)
const useLoop = (args) => switchEnv(args)

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
    // This month's Kriya Harness spend from Kriya's own ledger (GET /me);
    // --json is one line for scripts, KriyaBench's spend meter among them
    case "usage": {
      const device = signedIn()
      const { harness } = await me(device.url, device.token)
      if (args.includes("--json")) say(JSON.stringify({ usedMicroInr: harness.usedMicroInr, capMicroInr: harness.capMicroInr, unpriced: harness.unpriced }))
      else say(`This month: ₹${(harness.usedMicroInr / 1e6).toFixed(2)} of ₹${(harness.capMicroInr / 1e6).toFixed(2)}${harness.unpriced ? ` (${harness.unpriced} not priced yet)` : ""}.`)
      return 0
    }
    case "skills": {
      const [action, target] = args
      if (action === "link") {
        if (!target) throw new SkillsError("Which folder? kriya skills link <folder> [--only <a,b>]")
        const only = option(args, "--only")?.split(",").filter(Boolean)
        const { linked, kept } = linkSkills(target, only)
        const left = kept.length > 10 ? `${kept.length} names` : kept.join(", ")
        say(`Linked ${linked.length} skill(s) into ${skillsDir()}${kept.length ? `; already there, left alone: ${left}` : ""}.`)
      } else if (action === "unlink") {
        if (!target) throw new SkillsError("Which skill? kriya skills unlink <name>")
        unlinkSkill(target)
        say(`Unlinked ${target}.`)
      } else if (action === "off" || action === "on") {
        if (!target) throw new SkillsError(`Which skill? kriya skills ${action} <name>`)
        const state = action === "on" ? "on" : args.includes("--everywhere") ? "off-everywhere" : "off-here"
        try {
          setSkillSwitch(process.cwd(), target, state)
        } catch (error) {
          if (error instanceof SwitchError) throw new SkillsError(error.message)
          throw error
        }
        say(state === "on" ? `${target} is on.` : `${target} is off ${state === "off-here" ? `in ${projectRoot(process.cwd())}` : "everywhere"}.`)
      } else if (action) {
        say(`Unknown skills command ${action}.\n\n${HELP}`)
        return 1
      }
      const { skills, shadowed, catalogChars, offChars, off, broken, warnings } = await visibleSkills(process.cwd())
      const where = (skill) => SKILL_ROOTS[skill.source] ?? skill.source
      const state = (skill) => (off.has(skill.name) ? ` (off ${off.get(skill.name) === "here" ? "in this project" : "everywhere"})` : "")
      for (const skill of skills) say(`  ${skill.name.padEnd(36)} ${where(skill)}${state(skill)}`)
      for (const skill of shadowed) say(`  ${skill.name.padEnd(36)} ${where(skill)} (hidden by the one above)`)
      for (const name of broken) say(`  ${name.padEnd(36)} broken link: its folder is gone (kriya skills unlink ${name})`)
      for (const warning of warnings) say(`  not loaded: ${warning}`)
      // The agent gets the catalog once per session and resends it with every request
      const offCount = skills.filter((s) => off.has(s.name)).length
      say(
        `${skills.length - offCount} skill(s) on, ${offCount} off; the catalog is about ${Math.round(catalogChars / 4)} tokens on every request` +
          (offChars ? ` (turning skills off saves about ${Math.round(offChars / 4)}).` : ".")
      )
      if (catalogChars > HEAVY_CATALOG) say("That's a lot for every request: kriya skills off <name> for the ones this project doesn't need.")
      say("Your Kriya agent's own skills come on top of these.")
      return 0
    }
    case "verify": {
      const [action, ...rest] = args
      if (action === "use") {
        const suggestions = discoverChecks(process.cwd())
        const pick = rest.join(" ").trim()
        const chosen = /^\d+$/.test(pick) ? suggestions[Number(pick) - 1]?.command : pick
        if (/^\d+$/.test(pick) && !chosen) throw new VerifyError(`There's no check ${pick}; kriya verify lists them.`)
        const { root, command } = confirmCheck(process.cwd(), chosen)
        say(`Confirmed for ${root}: ${command}`)
        say("With the Kriya loop (on by default), the agent's work passes only when this exits 0.")
        return 0
      }
      if (action === "clear") {
        say(clearCheck(process.cwd()) ? "Forgot this project's check; work here is \"not checked\" again." : "This project had no check.")
        return 0
      }
      if (action !== undefined) {
        say(`Unknown verify command ${action}.\n\n${HELP}`)
        return 1
      }
      const check = confirmedCheck(process.cwd())
      say(check ? `Check for ${check.root}: ${check.command} (confirmed ${check.confirmedAt})` : "No check confirmed for this project: with the Kriya loop, work here ends \"not checked\".")
      const suggestions = discoverChecks(process.cwd())
      if (suggestions.length) {
        say("\nThis project defines:")
        suggestions.forEach((s, i) => say(`  ${i + 1}. ${s.command.padEnd(28)} ${s.source}`))
        say("\nkriya verify use <number> to confirm one, or kriya verify use \"<command>\".")
      } else say('This project defines no check Kriya recognises; kriya verify use "<command>" sets one.')
      return 0
    }
    case "rules": {
      const [action, n, ...words] = args
      if (action === "confirm") say(`Confirmed; the loop's builders now see: ${confirmRule(process.cwd(), n, words.join(" "))}`)
      else if (action === "dismiss") say(`Dismissed; it won't be proposed again: ${dismissRule(process.cwd(), n)}`)
      else if (action === "forget") say(`Removed: ${forgetRule(process.cwd(), n)}`)
      else if (action !== undefined) {
        say(`Unknown rules command ${action}.\n\n${HELP}`)
        return 1
      } else {
        const { proposed, confirmed } = listRules(process.cwd())
        say(confirmed.length ? `Rules you confirmed for ${projectRoot(process.cwd())}:` : "No confirmed rules for this project.")
        confirmed.forEach((t, i) => say(`  ${i + 1}. ${t}`))
        if (proposed.length) {
          say("\nProposed by the loop (from failures seen twice; the agent doesn't see these):")
          proposed.forEach((t, i) => say(`  ${i + 1}. ${t}`))
          say('\nkriya rules confirm <number> ["<your wording>"], or kriya rules dismiss <number>.')
        }
      }
      return 0
    }
    case "undo": {
      const [arg, ...rest] = args
      if (rest.length || (arg !== undefined && arg !== "--list" && !/^\d+$/.test(arg))) {
        say(`kriya undo takes --list or a number.\n\n${HELP}`)
        return 1
      }
      if (arg === "--list") {
        const root = await repoRoot(process.cwd())
        if (!root) throw new CheckpointError("This folder isn't a git repository, so there are no checkpoints.")
        const list = await listCheckpoints(root)
        if (!list.length) {
          say("No checkpoints yet: the Kriya loop saves one before each change the agent makes.")
          return 0
        }
        list.forEach((c, i) => say(`  ${String(i + 1).padStart(3)}. ${c.at.replace("T", " ").slice(0, 19)}  ${c.kind === "undone" ? "(saved by an undo) " : ""}${c.label}`))
        say("\nkriya undo <number> goes back to one; kriya undo goes back one step.")
        return 0
      }
      const { restored, changed, saved } = await undo(process.cwd(), { target: arg === undefined ? undefined : Number(arg) })
      if (!changed) say(`The files already match "${restored.label}".`)
      else {
        say(`Back to "${restored.label}" (${changed} file${changed === 1 ? "" : "s"} changed).`)
        say("What it replaced is kept: kriya undo --list shows it as saved by an undo.")
      }
      return 0
    }
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
      useLoop(args)
      const mode = parseMode(option(args, "--mode"))
      const device = signedIn()
      if (mode === "full") process.stderr.write(`${FULL_ACCESS_WARNING}\n`)
      // The job is the first argument that isn't a flag; plan asks for a plan
      const job = args.findIndex((arg) => !arg.startsWith("-"))
      if (mode === "plan" && job !== -1) args[job] = planJob(args[job])
      return runDsh("kriya-run", args, device, mode)
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
      // The same defaults as kriya run (U10), from the editor's environment
      useLoop([])
      return runDsh("kriya-acp", [], device)
    }
    case undefined:
    case "--mode":
    case "--loop":
    case "--budget":
    case "--anchor":
    case "--no-loop":
    case "--loop-v2":
    case "--no-loop-v2":
    case "--browser-tools":
    case "--no-browser-tools":
    case "--router":
    case "--no-router":
    case "--no-budget":
    case "--no-anchor":
    case "--no-open":
    case "--port": {
      // Only these Web UI flags pass through; never --host, so the UI stays on 127.0.0.1
      const flags = command === undefined ? [] : [command, ...args]
      useLoop(flags)
      const port = option(flags, "--port")
      const mode = option(flags, "--mode")
      if (mode === "plan") {
        say("In the app, type /plan to plan first. --mode plan is for kriya run.")
        return 1
      }
      const chosen = parseMode(mode, APP_MODES)
      if (port !== undefined && !/^\d{2,5}$/.test(port)) {
        say("--port takes a number, e.g. --port 8080.")
        return 1
      }
      if (flags.some((flag) => flag !== "--no-open")) {
        say(`Unknown option ${flags.find((flag) => flag !== "--no-open")}.\n\n${HELP}`)
        return 1
      }
      const device = signedIn()
      if (chosen === "full") process.stderr.write(`${FULL_ACCESS_WARNING}\n`)
      return runDsh("kriya", [...flags, ...(port ? ["--port", port] : [])], device, chosen)
    }
    default:
      say(`Unknown command ${command}.\n\n${HELP}`)
      return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    const known =
      error instanceof KriyaError ||
      error instanceof HandoffError ||
      error instanceof ServeError ||
      error instanceof ModeError ||
      error instanceof SkillsError ||
      error instanceof VerifyError ||
      error instanceof CheckpointError ||
      error instanceof RulesError
    process.stderr.write(`kriya: ${known ? error.message : error?.message ?? error}\n`)
    process.exit(1)
  }
)
