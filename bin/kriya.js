#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { handoff, HandoffError, pull } from "../plugins/kriya-handoff/index.js"
import { KriyaError, me, revokeDevice } from "../src/api.js"
import { doctor, nodeOk } from "../src/doctor.js"
import { runDsh } from "../src/launch.js"
import { localModelArgs } from "../src/local-model.js"
import { daemonPidFile, runDaemon, serviceDefinition } from "../src/daemon.js"
import { serve, servedFolder, ServeError } from "../src/world.js"
import { HEAVY_CATALOG, linkSkills, SKILL_ROOTS, skillsDir, SkillsError, unlinkSkill, visibleSkills } from "../src/local-skills.js"
import { CheckpointError, listCheckpoints, trackedRoot, undo } from "../src/checkpoints.js"
import { clearCheck, confirmCheck, confirmedCheck, discoverChecks, MAX_ATTEMPTS, sessionReport, VerifyError } from "../src/verify.js"
import { projectRoot, setSkillSwitch, SwitchError } from "../src/skill-switches.js"
import { confirmRule, dismissRule, forgetRule, listRules, RulesError } from "../src/rules.js"
import { forgetStack, hostedDatabase, readStack, shownDatabase, StackError, useStack } from "../src/stack.js"
import { COMMAND_GATES, confirmBaseline, forgetGateCommand, GateCommandError, gateCommands, useGateCommand } from "../src/gate-commands.js"
import { login } from "../src/login.js"
import { setShare, shareStatus } from "../src/outcomes.js"
import { latestSession, makeReceipt, makeReport, ReceiptError, verifyReceipt } from "../src/receipts.js"
import { readRelease, ReleaseError, useRelease } from "../src/release.js"
import { APP_MODES, FULL_ACCESS_WARNING, MODES, ModeError, parseMode, planJob, SWITCHES, switchEnv, WORKFORCE_SWITCHES } from "../src/modes.js"
import { CLIENT_VERSION, DSH_VERSION, kriyaHome } from "../src/paths.js"
import { deleteDevice, ensureHome, kriyaUrl, readDevice } from "../src/store.js"

// `kriya`: the Kriya Harness command (DSH_DISTRIBUTION §2). It signs in,
// picks a Kriya profile and hands over to DSH's own launcher.

const HELP = `Kriya Harness (beta)

Usage:
  kriya login [--url <your Kriya address>] [--no-browser]
  kriya [--mode <mode>] [--no-loop] [--loop-v2] [--loop-guard] [--strict-loop] [--defensive] [--recon] [--jit-tools] [--no-browser-tools] [--router] [--no-budget] [--anchor] [--no-open] [--port <n>]
                        [--local-model [<url>]] [--local-model-name <name>]
                        [--standalone] [--workforce] [--<switch> | --no-<switch>]
                        open the agent in your browser (local, 127.0.0.1)
                        --standalone: no Kriya account needed (also what happens when
                        you're signed out or Kriya is unreachable): your own API keys
                        (OpenRouter, OpenAI, …) or a local model, with Orchestration,
                        set up in the Developer tab. --workforce: every Harness 2.0 switch
                        --local-model: a model on this computer (Ollama or LM Studio, found
                        by itself, or <url> on your network) builds; Kriya's model plans
                        and reviews. Needs the orchestra and your Kriya owner's switch
  kriya run [--mode <mode>] [--no-loop] [--loop-v2] [--loop-guard] [--strict-loop] [--defensive] [--recon] [--jit-tools] [--no-browser-tools] [--router] [--no-budget] [--anchor] "<job>"
                        run one job and print the answer (--json for events)
  kriya run --standalone "<job>"   the same, without a Kriya account
  kriya acp [--standalone]   the agent for editors: an ACP server on stdin/stdout
  kriya usage [--json]  this month's Kriya Harness spend and limit
  kriya release use --build "<cmd>" --app http://localhost:<port> [--out dist] [--routes /,/pricing]
                    [--budget-kb <n>] [--domain <host>] [--headers <names>] [--marker "<text>"]
                        confirm how this project's production build is made and checked
  kriya release         show it
  kriya doctor --gates  which gates work on this computer, and their self-tests
  kriya report          write a redacted bundle for a bug report (you attach it)
  kriya receipt make [<session>]
                        write this project's proof receipt (what Kriya checked by
                        code on this computer) to ~/.kriya/receipts/
  kriya receipt verify <file>
                        recheck a receipt against this computer's records
  kriya share on|off|status
                        share counts of verified and blocked steps per role
                        cartridge version with Kriya (off by default; counts only)
                        (your editor starts it; kriya acp --help for details)
  kriya handoff ["<note>"]
                        hand this repository's uncommitted work to your Kriya
                        agent in a cloud workspace (HEAD must be on GitHub)
  kriya pull [<workspace id>]
                        bring a workspace's changes back on a new branch
                        kriya/pull-<id> (default: your last handoff)
  kriya daemon [--folder <path>]… [--allow-full-access] [--allow-serve] [--allow-edit]
               [--local-model [<url>]] [--local-model-name <name>]
                        let Kriya (/harness, your phone) run tasks, health checks,
                        rule decisions, handoff and pull on this computer, in this
                        folder and each --folder only, while it runs; with
                        --local-model, those tasks build on this computer's model
  kriya daemon install [same options]
                        keep it running in the background (launchd / systemd)
  kriya daemon uninstall
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
  kriya verify status [--session <id>] [--json]
                        where the newest session here stands, with each check
                        run as evidence; exits 0 only when verified
  kriya stack use --app http://localhost:<port> [--db postgresql://…@127.0.0.1:<port>/<db>]
                        confirm the app and database you run on this computer, for
                        the live gates (--gates): only local addresses are accepted
  kriya stack           show them; kriya stack forget removes them
  kriya gates use <data|eval|san|iac|sim|sim-headless> "<command>" [options]
                        confirm the command a gate runs (data: --output <path>;
                        eval: --metrics <file.json> --metric <name> [--direction
                        lower] [--margin <n>]; sim-headless: [--frame-budget-ms <n>])
  kriya gates           show them; kriya gates forget <gate> removes one
  kriya eval baseline confirm
                        make the last recorded evaluation the baseline G-EVAL compares to
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

--browser-tools (on where Google Chrome is installed; --no-browser-tools turns it
  off): the agent gets a browser for apps on this computer
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

/** Takes a bare flag out of `args`; true when it was there */
function flag(args, name) {
  const at = args.indexOf(name)
  if (at !== -1) args.splice(at, 1)
  return at !== -1
}

// --workforce: every Harness 2.0 switch on, as the person's own choice; a --no-<name>
// or KRIYA_<NAME>=off of theirs still wins
function workforceArg(args, env = process.env) {
  if (!flag(args, "--workforce")) return
  for (const [name, variable] of SWITCHES) if (WORKFORCE_SWITCHES.includes(name) && env[variable] === undefined) env[variable] = "on"
}

// The loop, budget and kept-request switches (src/modes.js switchEnv), --workforce,
// and --local-model [url] / --local-model-name <name> (S-1, src/local-model.js)
const useLoop = (args) => (workforceArg(args), switchEnv(args), localModelArgs(args))


function signedIn() {
  const device = readDevice()
  if (!device) {
    say("This needs a Kriya account: run `kriya login`. (kriya, kriya run and kriya acp work without one, in Standalone Mode.)")
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
      if (args.includes("--gates")) {
        const { doctorGates } = await import("../src/doctor.js")
        return (await doctorGates()) ? 0 : 1
      }
      return (await doctor()) ? 0 : 1
    case "release": {
      const [action, ...rest] = args
      if (action === "use") {
        try {
          const entry = useRelease(process.cwd(), {
            build: option(rest, "--build"),
            app: option(rest, "--app"),
            out: option(rest, "--out"),
            routes: option(rest, "--routes"),
            budgetKb: option(rest, "--budget-kb"),
            domain: option(rest, "--domain"),
            headers: option(rest, "--headers"),
            marker: option(rest, "--marker"),
          })
          say(`Release confirmed: build \`${entry.build}\`${entry.app ? `, production server ${entry.app}` : " (no production server yet: start it and add --app http://localhost:<port>)"}.`)
          return 0
        } catch (error) {
          if (error instanceof ReleaseError) {
            say(error.message)
            return 1
          }
          throw error
        }
      }
      if (action !== undefined) {
        say(`Unknown release command ${action}.\n\n${HELP}`)
        return 1
      }
      const release = readRelease(process.cwd())
      say(release ? JSON.stringify(release, null, 2) : 'No release confirmed: kriya release use --build "<command>" --app http://localhost:<port> sets one.')
      return 0
    }
    case "report": {
      const { file } = await makeReport(projectRoot(process.cwd()))
      say(`Wrote ${file}. It holds versions, the gates' matrix and self-tests, and this project's receipts: no file contents, prompts, commands' secrets or query strings. Attach it yourself if you report a bug.`)
      return 0
    }
    // Track E: nothing under src/edit/ loads unless the switch is on
    case "edit": {
      useLoop(args)
      if (process.env.KRIYA_EDIT !== "on") {
        say("Editing is off. Run kriya edit --edit to open the Editing Studio, or set KRIYA_EDIT=on.")
        return 1
      }
      const { editCommand } = await import("../src/edit/runtime/cli.js")
      return editCommand(args)
    }
    // This month's Kriya Harness spend from Kriya's own ledger (GET /me);
    // --json is one line for scripts, KriyaBench's spend meter among them
    case "usage": {
      const device = signedIn()
      const { harness } = await me(device.url, device.token)
      if (args.includes("--json")) say(JSON.stringify({ usedMicroInr: harness.usedMicroInr, capMicroInr: harness.capMicroInr, unpriced: harness.unpriced }))
      else say(`This month: ₹${(harness.usedMicroInr / 1e6).toFixed(2)} of ₹${(harness.capMicroInr / 1e6).toFixed(2)}${harness.unpriced ? ` (${harness.unpriced} not priced yet)` : ""}.`)
      return 0
    }
    case "receipt": {
      const [action, target] = args
      if (action === "make") {
        const root = projectRoot(process.cwd())
        const session = target ?? latestSession(root)
        if (!session) {
          say("No Kriya session has records in this project yet.")
          return 1
        }
        try {
          const { receipt, files } = makeReceipt(root, session)
          say(`Receipt for session ${session}: ${receipt.verdict}, ${receipt.runs} check run(s), chain ${receipt.chain}.\n${files.json}\n${files.md}`)
          return 0
        } catch (error) {
          if (error instanceof ReceiptError || error instanceof VerifyError) {
            say(error.message)
            return 1
          }
          throw error
        }
      }
      if (action === "verify" && target) {
        let text
        try {
          text = readFileSync(target, "utf8")
        } catch {
          say(`Can't read ${target}.`)
          return 1
        }
        const { ok, problems } = verifyReceipt(text)
        say(ok ? "The receipt matches this computer's records: every run and field checks out." : `The receipt doesn't match:\n${problems.map((p) => `- ${p}`).join("\n")}`)
        return ok ? 0 : 1
      }
      say("kriya receipt make [<session>] | kriya receipt verify <file>")
      return 1
    }
    case "share": {
      const [action] = args
      if (action === "on" || action === "off") {
        setShare(action === "on")
        say(
          action === "on"
            ? "Sharing is on: Kriya gets counts of verified, blocked and unchecked steps per role cartridge version, with your mirrored turns. No text, names or files. kriya share off stops it."
            : "Sharing is off. Counts not yet sent were dropped."
        )
        return 0
      }
      if (action === undefined || action === "status") {
        const { on, changedAt } = shareStatus()
        say(on ? `Sharing is on${changedAt ? ` (since ${changedAt})` : ""}: counts only, sent with mirrored turns.` : "Sharing is off (the default). kriya share on shares counts of step outcomes per role cartridge version.")
        return 0
      }
      say("kriya share takes on, off or status.")
      return 1
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
      if (action === "status") {
        const json = rest.includes("--json")
        const report = await sessionReport(process.cwd(), option(rest, "--session"))
        if (json) say(JSON.stringify(report))
        else {
          say(`Verdict: ${report.status}${report.stale ? " (files changed since the last pass)" : ""}${report.session ? ` (session ${report.session})` : ""}`)
          for (const s of report.steps) say(`  ${s.status.padEnd(7)} ${s.step} (${s.attempts} run${s.attempts === 1 ? "" : "s"})`)
          for (const r of report.runs) say(`  ${r.at} ${r.step}: ${r.status}, exit ${r.exitCode ?? "none"}${r.kind ? `, ${r.kind}` : ""}${r.stalled ? `, stopped: ${r.stalled}` : ""} \`${r.command}\``)
        }
        return report.status === "verified" ? 0 : 1
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
    case "stack": {
      const [action, ...rest] = args
      if (action === "use") {
        const entry = useStack(process.cwd(), { app: option(rest, "--app"), db: option(rest, "--db") })
        say(`Confirmed for ${entry.root}:${entry.app ? ` app ${entry.app}` : ""}${entry.db ? ` database ${shownDatabase(entry.db)}` : ""}`)
        say("With --gates, the live gates check against these and nothing else. The API and tenant gates send requests to this app, writes included, using the test identities in .kriya/gates/tenants.json; migrations run in a transaction that is rolled back.")
        return 0
      }
      if (action === "forget") {
        say(forgetStack(process.cwd()) ? "Forgot this project's stack." : "This project had no stack.")
        return 0
      }
      if (action !== undefined) {
        say(`Unknown stack command ${action}.\n\n${HELP}`)
        return 1
      }
      const stack = readStack(process.cwd())
      say(stack.app || stack.db ? `App: ${stack.app ?? "none"}\nDatabase: ${stack.db ? shownDatabase(stack.db) : "none"}` : 'No stack confirmed: kriya stack use --app http://localhost:<port> sets one.')
      const hosted = hostedDatabase(projectRoot(process.cwd()))
      if (hosted) say(`${hosted.variable} in ${hosted.file} points off this computer, so the database gate won't run here.`)
      return 0
    }
    case "gates": {
      const [action, gate, ...rest] = args
      if (action === "use") {
        const words = []
        const opts = {}
        for (let i = 0; i < rest.length; i++) {
          const m = /^--(output|metrics|metric|direction|margin|frame-budget-ms)$/.exec(rest[i])
          if (m) opts[m[1] === "frame-budget-ms" ? "frameBudgetMs" : m[1]] = rest[++i]
          else words.push(rest[i])
        }
        const e = useGateCommand(process.cwd(), gate, words.join(" "), opts)
        say(`Confirmed ${COMMAND_GATES[gate].id} for ${e.root}: ${e.command}`)
        return 0
      }
      if (action === "forget") {
        say(forgetGateCommand(process.cwd(), gate) ? `Forgot the ${gate} gate's command.` : `No ${gate} command was confirmed.`)
        return 0
      }
      if (action !== undefined) {
        say(`Unknown gates command ${action}.\n\n${HELP}`)
        return 1
      }
      const mine = gateCommands(process.cwd())
      for (const [name, spec] of Object.entries(COMMAND_GATES)) say(`  ${spec.id.padEnd(15)} ${mine[name] ? mine[name].command : `not confirmed (${spec.what})`}`)
      return 0
    }
    case "eval": {
      const [what, action] = args
      if (what !== "baseline" || action !== "confirm") {
        say(`kriya eval baseline confirm\n\n${HELP}`)
        return 1
      }
      const c = confirmBaseline(process.cwd())
      say(`Baseline confirmed: ${c.metric} = ${c.value} (${c.direction} is better). G-EVAL fails anything worse.`)
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
        const root = (await trackedRoot(process.cwd()))?.root
        if (!root) throw new CheckpointError("Kriya doesn't track this folder (your home folder or a drive root), so there are no checkpoints.")
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
    case "daemon": {
      const sub = args[0] === "install" || args[0] === "uninstall" ? args.shift() : null
      const folders = []
      let allowFullAccess = false
      let allowServe = false
      let allowEdit = false
      // S-1/S-3: tasks from Kriya build on this computer's model too (src/local-model.js); the child runs inherit it
      localModelArgs(args)
      const local = process.env.KRIYA_LOCAL_MODEL
      const localFlags = local && local !== "off" ? ["--local-model", ...(local === "on" ? [] : [local]), ...(process.env.KRIYA_LOCAL_MODEL_NAME ? ["--local-model-name", process.env.KRIYA_LOCAL_MODEL_NAME] : [])] : []
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--folder" && args[i + 1]) folders.push(args[++i])
        else if (args[i] === "--allow-full-access") allowFullAccess = true
        else if (args[i] === "--allow-serve") allowServe = true
        else if (args[i] === "--allow-edit") allowEdit = true
        else {
          say("Usage: kriya daemon [install|uninstall] [--folder <path>]… [--allow-full-access] [--allow-serve] [--allow-edit] [--local-model [<url>]] [--local-model-name <name>]")
          return 1
        }
      }
      const { resolve } = await import("node:path")
      const offered = [process.cwd(), ...folders].map((f) => resolve(f))
      if (sub) {
        const { mkdirSync, unlinkSync } = await import("node:fs")
        const { spawnSync } = await import("node:child_process")
        const { dirname } = await import("node:path")
        const service = serviceDefinition({
          bin: new URL(import.meta.url).pathname,
          args: [...offered.flatMap((f) => ["--folder", f]), ...(allowFullAccess ? ["--allow-full-access"] : []), ...(allowServe ? ["--allow-serve"] : []), ...(allowEdit ? ["--allow-edit"] : []), ...localFlags],
        })
        if (!service) {
          say("kriya daemon install supports macOS (launchd) and Linux (systemd). Run kriya daemon in a terminal instead.")
          return 1
        }
        const run = (steps) => steps.every(([cmd, ...rest]) => spawnSync(cmd, rest, { stdio: "inherit" }).status === 0)
        if (sub === "uninstall") {
          if (!existsSync(service.path)) {
            say("The daemon isn't installed.")
            return 0
          }
          run(service.stop)
          unlinkSync(service.path)
          say("The daemon is uninstalled; Kriya can't reach this computer until you start it again.")
          return 0
        }
        signedIn()
        mkdirSync(dirname(service.path), { recursive: true })
        if (existsSync(service.path)) run(service.stop)
        writeFileSync(service.path, service.content, { mode: 0o600 })
        if (!run(service.start)) {
          say(`Wrote ${service.path}, but it didn't start; see the message above.`)
          return 1
        }
        say(`The daemon runs in the background for: ${offered.join(", ")}.`)
        say(`Logs: ~/.kriya/daemon.log. Stop it with kriya daemon uninstall.`)
        return 0
      }
      const device = signedIn()
      if (allowFullAccess) process.stderr.write(`kriya daemon: Full access from Kriya is allowed. ${FULL_ACCESS_WARNING}\n`)
      const stop = new AbortController()
      process.once("SIGINT", () => stop.abort())
      process.once("SIGTERM", () => stop.abort())
      writeFileSync(daemonPidFile(), String(process.pid), { mode: 0o600 })
      // Asking for it by name turns editing on for this daemon and its Edit Host
      if (allowEdit) process.env.KRIYA_EDIT = "on"
      await runDaemon({ device, folders: offered, allowFullAccess, allowServe, allowEdit, signal: stop.signal, log: say })
      rmSync(daemonPidFile(), { force: true })
      say("kriya daemon stopped.")
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
      const standalone = flag(args, "--standalone")
      const mode = parseMode(option(args, "--mode"))
      const device = readDevice()
      if (mode === "full") process.stderr.write(`${FULL_ACCESS_WARNING}\n`)
      // The job is the first argument that isn't a flag; plan asks for a plan
      const job = args.findIndex((arg) => !arg.startsWith("-"))
      if (mode === "plan" && job !== -1) args[job] = planJob(args[job])
      return runDsh("kriya-run", args, device, mode, { standalone })
    }
    case "acp": {
      // Stdout carries only ACP frames (newline-delimited JSON-RPC), so
      // everything kriya itself says goes to stderr. DSH's ACP app takes no
      // options but --help; the transport is stdio, the editor's choice
      const standalone = flag(args, "--standalone")
      const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h")
      if (args.length && !help) {
        process.stderr.write(`kriya acp takes no options but --help. (--standalone runs it without a Kriya account.)\n`)
        return 1
      }
      if (help) {
        say(ACP_HELP)
        return 0
      }
      // Signed out: Standalone Mode (src/launch.js says so on stderr)
      const device = readDevice()
      // The same defaults as kriya run (U10), from the editor's environment
      useLoop([])
      return runDsh("kriya-acp", [], device, undefined, { standalone })
    }
    // The Web UI: plain `kriya` and any flag (every switch in src/modes.js SWITCHES, --workforce,
    // --standalone, --mode, --port, --no-open, --local-model); anything else is refused below
    case undefined:
    default: {
      if (command !== undefined && !command.startsWith("-")) {
        say(`Unknown command ${command}.\n\n${HELP}`)
        return 1
      }
      // Only these Web UI flags pass through; never --host, so the UI stays on 127.0.0.1
      const flags = command === undefined ? [] : [command, ...args]
      useLoop(flags)
      const standalone = flag(flags, "--standalone")
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
      const device = readDevice()
      if (chosen === "full") process.stderr.write(`${FULL_ACCESS_WARNING}\n`)
      return runDsh("kriya", [...flags, ...(port ? ["--port", port] : [])], device, chosen, { standalone })
    }
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
      error instanceof RulesError ||
      error instanceof StackError ||
      error instanceof GateCommandError
    process.stderr.write(`kriya: ${known ? error.message : error?.message ?? error}\n`)
    process.exit(1)
  }
)
