import { spawn, spawnSync } from "node:child_process"

import { BASE_PATH } from "./api.js"
import { CLIENT_VERSION, DSH_BIN, kriyaHome } from "./paths.js"
import { ensureProfile } from "./profiles.js"

// Booting stays DSH's: `node <pinned dsh>/lib/bin.js --profile <name> …` with
// the Kriya home as DSH_HOME. The Kriya rows read three launch variables:
// the gateway address, the client version for X-Kriya-Harness, and the
// device token. The token's name contains TOKEN, so DSH scrubs it from every
// shell the agent runs (dsh-subprocess SENSITIVE_ENV_PATTERN; tested).

export const TOKEN_ENV = "KRIYA_DEVICE_TOKEN"

/** @param {{ url: string, token: string } | null} device */
export function launchEnv(device, base = process.env) {
  const env = {
    ...base,
    DSH_HOME: kriyaHome(),
    // Telemetry exporters are disabled rows in the kriya bundle; this is DSH's own switch too
    DSH_TELEMETRY_DISABLED: "1",
    KRIYA_CLIENT_VERSION: CLIENT_VERSION,
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
  tier_not_allowed: "That model tier isn't on your plan.",
  harness_off: "Kriya Harness is switched off for now.",
  rate_limited: "Too many requests; wait a minute and try again.",
  upstream_unavailable: "Kriya's model provider isn't answering; try again shortly.",
  not_priced: "Kriya can't price this request yet; try again later.",
  unauthorized: "This device is signed out. Run kriya login.",
  suspended: "This Kriya account is paused.",
  upgrade: "Update Kriya Harness (npm install -g @kriya-ai/harness).",
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

/** Runs DSH in the foreground, passing the terminal through; resolves with its exit code. */
export function runDsh(profile, rest, device) {
  ensureProfile(profile)
  const headless = profile === "kriya-run"
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args(profile, rest), {
      stdio: headless ? ["inherit", "inherit", "pipe"] : "inherit",
      env: launchEnv(device),
    })
    let explained = null
    if (headless) {
      let buffered = ""
      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk)
        buffered = (buffered + chunk).slice(-4096)
        explained ??= explain(buffered)
      })
    }
    // Ctrl-C reaches the child directly (same process group): forwarding it
    // too would be a second interrupt, which DSH treats as force-exit. A
    // SIGTERM or SIGHUP sent to kriya alone is passed on, or DSH would outlive it
    process.on("SIGINT", () => {})
    for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
    child.on("error", fail)
    child.on("exit", (code, signal) => {
      if (explained) process.stderr.write(`kriya: ${explained}\n`)
      done(code ?? (signal ? 1 : 0))
    })
  })
}

/** Composes a profile without booting it (`--dump-config`); returns the YAML. */
export function dumpConfig(profile, device = null) {
  ensureProfile(profile)
  const result = spawnSync(process.execPath, args(profile, ["--dump-config"]), {
    env: launchEnv(device),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`dsh --dump-config failed for ${profile}: ${(result.stderr || "").trim().slice(0, 500)}`)
  }
  return result.stdout
}
