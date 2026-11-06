import { spawn, spawnSync } from "node:child_process"

import { broadcastRun } from "./daemon.js"
import { BODY_ENCODING, startGatewayProxy } from "./gateway-proxy.js"
import { BASE_PATH, models } from "./api.js"
import { DEFAULT_MODE, modeEnv } from "./modes.js"
import { CLIENT_VERSION, DSH_BIN, kriyaHome } from "./paths.js"
import { ensureProfile } from "./profiles.js"

// Booting stays DSH's: `node <pinned dsh>/lib/bin.js --profile <name> …` with
// the Kriya home as DSH_HOME. The Kriya rows read three launch variables:
// the gateway address, the client version for X-Kriya-Harness, and the
// device token. The token's name contains TOKEN, so DSH scrubs it from every
// shell the agent runs (dsh-subprocess SENSITIVE_ENV_PATTERN; tested).

export const TOKEN_ENV = "KRIYA_DEVICE_TOKEN"

// Kriya's tier aliases in the order a session starts on them. A free plan may
// allow only budget; starting on a tier the plan lacks fails every request
// with tier_not_allowed
export const START_TIERS = ["balanced", "budget", "escalation"]

/**
 * The tiers the plan allows (GET /models), in START_TIERS order, and the
 * one a session starts on. The model picker offers only these, so a tier
 * the plan refuses (tier_not_allowed on every request) can't be chosen.
 * When Kriya can't be asked, all of them: the gateway still refuses what
 * the plan lacks, and a short outage mustn't leave the picker empty.
 */
export async function planTiers(device, list = models) {
  const all = { start: START_TIERS[0], allowed: [...START_TIERS], names: {}, limits: {}, encodings: [] }
  if (!device) return all
  try {
    const answer = await list(device.url, device.token)
    const data = answer.data
    // The request-body forms Kriya decodes (src/gateway-proxy.js); none from an older Kriya
    const encodings = Array.isArray(answer.bodyEncodings) ? answer.bodyEncodings.filter((e) => typeof e === "string") : []
    const offered = new Set(data.map((model) => model.id))
    const allowed = START_TIERS.filter((tier) => offered.has(tier))
    return allowed.length ? { start: allowed[0], allowed, names: modelNames(data, allowed), limits: modelLimits(data, allowed), encodings } : { ...all, encodings }
  } catch {
    // Kriya answers the first request with the reason if it's refused
    return all
  }
}

// The contract's own rule for a model name (contract/contract.json /models)
const MODEL_NAME = /^[\p{L}\p{N} .()+\/:_-]{1,60}$/u

/**
 * What the picker shows per tier: the model the owner routes it to, as Kriya
 * names it ("DeepSeek V4.1 Flash"), with the tier added where two tiers run
 * on the same model. A tier without a usable name keeps "Kriya <tier>".
 */
export function modelNames(data, allowed) {
  const named = Object.fromEntries(
    data.filter((m) => allowed.includes(m.id) && typeof m.name === "string" && MODEL_NAME.test(m.name)).map((m) => [m.id, m.name])
  )
  const count = (name) => Object.values(named).filter((n) => n === name).length
  return Object.fromEntries(Object.entries(named).map(([tier, name]) => [tier, count(name) > 1 ? `${name} · ${tier}` : name]))
}

// DSH's own compaction headroom (dsh-compaction-basic headroomTokens)
const DSH_HEADROOM = 65536
// The most context a request may use: DSH's own default window. A model that
// holds more (the budget tier's holds 1,048,576) still compacts here, because
// cost grows with every token re-sent and quality falls on long contexts;
// raise it only when KriyaBench shows it pays (KU-ADR-09)
export const WORKING_WINDOW = 262144
const positive = (n) => Number.isSafeInteger(n) && n > 0

/**
 * What each tier's model holds (harness upgrade U3), from GET /models:
 * DSH then compacts before a smaller model's real window is full instead of
 * assuming 262,144 tokens for every tier (never more than WORKING_WINDOW). The output cap is the gateway's
 * (never above a quarter of the window) and the compaction headroom is a
 * quarter of the window at most, so DSH's trigger W − O − headroom stays
 * positive on small windows. A tier Kriya gives no limits for keeps DSH's
 * defaults, exactly as before.
 */
export function modelLimits(data, allowed) {
  return Object.fromEntries(
    data
      .filter((m) => allowed.includes(m.id) && positive(m.contextWindow) && positive(m.maxOutputTokens))
      .map((m) => {
        const window = Math.min(m.contextWindow, WORKING_WINDOW)
        const quarter = Math.floor(window / 4)
        return [m.id, { contextWindow: window, maxTokens: Math.min(m.maxOutputTokens, quarter), headroomTokens: Math.min(DSH_HEADROOM, quarter) }]
      })
  )
}

/** The first of START_TIERS the plan allows; balanced when Kriya can't be asked. */
export async function startTier(device, list = models) {
  return (await planTiers(device, list)).start
}

/** @param {{ url: string, token: string } | null} device */
export function launchEnv(device, base = process.env, mode = DEFAULT_MODE, tier = START_TIERS[0], allowed = START_TIERS, names = {}, limits = {}) {
  const env = {
    ...base,
    // The mode always comes from `--mode` (or the default), never the shell
    ...modeEnv(mode),
    DSH_HOME: kriyaHome(),
    // Telemetry exporters are disabled rows in the kriya bundle; this is DSH's own switch too
    DSH_TELEMETRY_DISABLED: "1",
    KRIYA_CLIENT_VERSION: CLIENT_VERSION,
    KRIYA_START_TIER: START_TIERS.includes(tier) ? tier : START_TIERS[0],
    // Read by the kriya provider row: the models the picker offers. Never from the shell
    KRIYA_ALLOWED_TIERS: (allowed.filter((t) => START_TIERS.includes(t)).length ? allowed.filter((t) => START_TIERS.includes(t)) : START_TIERS).join(","),
    // The picker's name per tier (modelNames), as JSON. Never from the shell
    KRIYA_MODEL_NAMES: JSON.stringify(Object.fromEntries(Object.entries(names).filter(([t, n]) => START_TIERS.includes(t) && typeof n === "string" && n.length <= 80))),
    // Each tier's context window, output cap and compaction headroom (modelLimits), as JSON. Never from the shell
    KRIYA_MODEL_LIMITS: JSON.stringify(Object.fromEntries(Object.entries(limits).filter(([t]) => START_TIERS.includes(t)))),
  }
  // A token from the person's environment never stands in for the sign-in
  delete env[TOKEN_ENV]
  delete env.KRIYA_GATEWAY_URL
  if (device) {
    env[TOKEN_ENV] = device.token
    env.KRIYA_GATEWAY_URL = `${device.url}${BASE_PATH}`
  }
  return env
}

function args(profile, rest) {
  return [DSH_BIN, "--profile", profile, ...rest]
}

// Kriya's refusals reach DSH's OpenAI-compatible route as `{ error: "<code>",
// message }`, which pi-ai reports as `PI_AI_ERROR: <status> "<code>"`, dropping
// the sentence. Until the gateway answers in OpenAI's error shape, `kriya run`
// adds the plain words for the contract's codes (shortcut: headless only; the
// Web UI still shows the code; upgrade by changing the gateway's error shape).
export const REFUSALS = {
  cap_reached: "This month's Kriya Harness limit is reached. It resets on the 1st (India time), or raise it in your plan.",
  plan_not_allowed: "Kriya Harness isn't part of your plan.",
  context_length_exceeded: "The conversation grew past the model's context window and couldn't be compacted enough; start a new session or type /compact.",
  tier_not_allowed: "That model tier isn't on your plan; choose another in the model picker, or restart kriya to see only your plan's tiers.",
  harness_off: "Kriya Harness is switched off for now.",
  rate_limited: "Too many requests; wait a minute and try again.",
  upstream_unavailable: "Kriya's model provider isn't answering; try again shortly.",
  not_priced: "Kriya can't price this request yet; try again later.",
  unauthorized: "This device is signed out. Run kriya login.",
  suspended: "This Kriya account is paused.",
  upgrade: "Update Kriya Harness (npm install -g @kriya-ai/harness).",
  not_found: "Kriya Harness isn't available on this Kriya address; check it with kriya doctor.",
  bad_request: "Kriya couldn't read that request; update Kriya Harness and try again.",
  server_error: "Something went wrong in Kriya; try again shortly.",
  // H6: the mirror's refusals (the plugin handles them; listed for completeness)
  no_agent: "Choose the agent this computer works as in Kriya, Account → Devices.",
  mirror_summary_only: "This computer mirrors summaries only.",
  // H8: handoff and pull (kriya handoff / kriya pull print Kriya's own sentence)
  not_connected: "Connect GitHub in Kriya, Account → Apps, then hand off again.",
  too_large: "The changes are larger than a handoff allows.",
  patch_mismatch: "The upload was damaged on the way; hand off again.",
  no_checkpoint: "This workspace has no changes saved yet.",
  task_refused: "Kriya couldn't start the task for this handoff; try again shortly.",
}

const PI_AI_ERROR = /PI_AI_ERROR: \d{3} "([a-z_]+)"/

/** The plain sentence for a DSH error line naming a Kriya refusal, if any. */
export function explain(line) {
  const code = PI_AI_ERROR.exec(line)?.[1]
  return code && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null
}

const HTML_ERROR = /^dsh: \w+: (\d{3}) <(!DOCTYPE|html)/i

/**
 * Passes DSH's stderr through line by line, except a web page as an error
 * body: when Kriya's host answers with its own error page (a deploy, an
 * outage), DSH prints the whole HTML. That page is dropped and `explained`
 * says what happened instead.
 * @param {(text: string) => void} write
 */
export function htmlFilter(write) {
  let partial = ""
  let inPage = false
  const state = {
    /** @type {string | null} */
    explained: null,
    push(text) {
      const lines = (partial + text).split("\n")
      partial = lines.pop() ?? ""
      for (const line of lines) {
        if (inPage) {
          if (/<\/html>/i.test(line)) inPage = false
          continue
        }
        const page = HTML_ERROR.exec(line)
        if (page) {
          inPage = !/<\/html>/i.test(line)
          state.explained = `Kriya didn't answer (HTTP ${page[1]}); it may be restarting. Changes made so far stay in this folder; try again in a minute.`
          continue
        }
        write(`${line}\n`)
      }
    },
    end() {
      if (partial && !inPage) write(partial)
      partial = ""
    },
  }
  return state
}

/**
 * DSH's own terminal lines in Kriya Harness's words (owner, 2026-11-06): the
 * product people run is Kriya Harness; DSH stays credited in --version and
 * the notices. Only a line's leading "dsh web:" / "dsh:" changes.
 */
export function rebrand(text) {
  return text
    .replace(/^dsh web: opening the default browser; pass --no-open to disable/, "Kriya Harness: opening your browser (kriya --no-open to skip)")
    .replace(/^dsh web: /, "Kriya Harness: ")
    .replace(/^dsh: /, "kriya: ")
}

/** Writes a stream's text through `rebrand`, whole lines at a time */
function relines(stream, write) {
  let partial = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    const lines = (partial + chunk).split("\n")
    partial = lines.pop() ?? ""
    for (const line of lines) write(`${rebrand(line)}\n`)
  })
  stream.on("end", () => partial && write(rebrand(partial)))
}

/** Runs DSH in the foreground, passing the terminal through; resolves with its exit code. */
export async function runDsh(profile, rest, device, mode = DEFAULT_MODE) {
  ensureProfile(profile)
  const headless = profile === "kriya-run"
  const tiers = await planTiers(device)
  // DSH and the Kriya plugins reach Kriya through the local relay
  // (src/gateway-proxy.js): encoded bodies past the host's firewall, and a
  // block said as such. KRIYA_RELAY=off talks to Kriya directly, as before
  const relay =
    device && process.env.KRIYA_RELAY !== "off"
      ? await startGatewayProxy({
          target: device.url,
          encode: tiers.encodings.includes(BODY_ENCODING),
          // A Kriya deployed after launch is picked up without a restart
          checkSupport: async () => ((await models(device.url, device.token)).bodyEncodings ?? []).includes(BODY_ENCODING),
          log: (text) => process.stderr.write(`kriya: ${text}\n`),
        })
      : null
  // What this process runs, for Kriya's Control Center (no task text; nothing on a Kriya without it)
  const on = (name) => process.env[name] === "on"
  const broadcast = broadcastRun(device, {
    kind: profile === "kriya-run" ? "run" : profile === "kriya-acp" ? "acp" : "app",
    mode,
    switches: { loop: on("KRIYA_LOOP"), loopV2: on("KRIYA_LOOP_V2"), budget: on("KRIYA_BUDGET"), anchor: on("KRIYA_ANCHOR"), browser: on("KRIYA_BROWSER") },
  })
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args(profile, rest), {
      // stdout: the answer (kriya run) and ACP's protocol frames pass untouched;
      // the Web UI's stdout carries only log lines, rebranded like stderr
      stdio: ["inherit", profile === "kriya" ? "pipe" : "inherit", "pipe"],
      env: launchEnv(relay ? { ...device, url: relay.url } : device, process.env, mode, tiers.start, tiers.allowed, tiers.names, tiers.limits),
    })
    let explained = null
    const filter = htmlFilter((text) => process.stderr.write(rebrand(text)))
    if (child.stdout) relines(child.stdout, (text) => process.stdout.write(text))
    if (!headless) relines(child.stderr, (text) => process.stderr.write(text))
    if (headless) {
      let buffered = ""
      // Whole characters per chunk, so a split one never reaches the filter
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => {
        filter.push(chunk)
        buffered = (buffered + chunk).slice(-4096)
        explained ??= explain(buffered) ?? filter.explained
      })
    }
    // Ctrl-C reaches the child directly (same process group): forwarding it
    // too would be a second interrupt, which DSH treats as force-exit. A
    // SIGTERM or SIGHUP sent to kriya alone is passed on, or DSH would outlive it
    process.on("SIGINT", () => {})
    for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
    child.on("error", (error) => {
      relay?.close()
      fail(error)
    })
    // close, not exit: stderr may still hold the last lines when DSH exits
    child.on("close", (code, signal) => {
      relay?.close()
      // Kriya hears how it ended before kriya exits (each request is capped at 5 s)
      const ended = broadcast.end(code === 0 ? "completed" : signal ? "stopped" : "failed", code ?? undefined)
      filter.end()
      explained ??= filter.explained
      if (explained) process.stderr.write(`kriya: ${explained}\n`)
      ended.finally(() => done(code ?? (signal ? 1 : 0)))
    })
  })
}

/** Composes a profile without booting it (`--dump-config`); returns the YAML. */
export function dumpConfig(profile, device = null, mode = DEFAULT_MODE) {
  ensureProfile(profile)
  const result = spawnSync(process.execPath, args(profile, ["--dump-config"]), {
    env: launchEnv(device, process.env, mode),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`dsh --dump-config failed for ${profile}: ${(result.stderr || "").trim().slice(0, 500)}`)
  }
  return result.stdout
}
