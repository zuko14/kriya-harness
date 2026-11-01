import { call, deviceFromEnv } from "../../src/api.js"

// Kriya approvals plugin (H5, HD-08): when DeepSeek Harness asks before a
// tool runs, the person can answer here (DSH's own prompt) or in Kriya on
// their phone; the first answer wins and the other side is withdrawn.
//
// DSH's approval request names the tool and the call id but not the
// arguments (dsh-user-approval's README), so a passive `tools/pre-execute`
// listener remembers each call's arguments by call id. The answerer is
// prepended to the `approval/request` waterfall: it posts the request to
// Kriya, then sends a copy of it down the rest of the chain with its own
// abort signal, so whichever side loses can be withdrawn. Nothing here
// approves on its own: no answer from either side is `unavailable`, which
// DSH treats as a refusal (fail closed). Arguments are never logged.

export const name = "kriya-approvals"

const PHONE_LINE = "Waiting for your answer here or in Kriya on your phone."
// The contract's limits (ApprovalCreateRequest)
const MAX_INPUT = 8 * 1024
const MAX_SUMMARY = 300
// Calls whose arguments are kept until their approval asks
const REMEMBERED = 200
const POLL_SECONDS = 25
const MAX_FAILURES = 5

// Redacted before anything leaves the machine; Kriya redacts again
const SECRET_KEY =
  /pass(word|wd|phrase)|secret|token|api[-_]?key|^auth$|authorization|cookie|credential|private[-_]?key|^otp$|cvv|card[-_]?number/i

export function hideSecrets(value) {
  if (Array.isArray(value)) return value.map(hideSecrets)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      inner && typeof inner === "object" ? hideSecrets(inner) : SECRET_KEY.test(key) ? "[redacted]" : inner,
    ])
  )
}

/** The call's arguments as the contract's `input`: an object of at most 8 KB as JSON */
export function inputFor(args) {
  if (args === undefined) return { arguments: "not shared by this tool" }
  const plain = args && typeof args === "object" && !Array.isArray(args) ? args : { arguments: args }
  const hidden = hideSecrets(plain)
  const text = JSON.stringify(hidden)
  if (text.length <= MAX_INPUT) return hidden
  let keep = MAX_INPUT - 64
  while (JSON.stringify({ truncated: text.slice(0, keep) }).length > MAX_INPUT) keep -= 256
  return { truncated: text.slice(0, keep) }
}

const sleep = (ms, signal) =>
  new Promise((done) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true })
  })

// The phone's answer: allowed-once, rejected, or null for none (expired,
// canceled, signed out, Kriya unreachable or this side withdrawn)
async function phoneAnswer(device, id, signal) {
  let failures = 0
  while (!signal.aborted) {
    try {
      const { status } = await call(device.url, "GET", `/approvals/${id}?wait=${POLL_SECONDS}`, {
        token: device.token,
        signal: AbortSignal.any([signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)]),
      })
      failures = 0
      if (status === "approved") return "allowed-once"
      if (status === "declined") return "rejected"
      if (status !== "pending") return null
    } catch (error) {
      if (signal.aborted) return null
      // Signed out, gone or refused: the phone can't answer this one
      if (error.status >= 400 && error.status < 500 && error.status !== 429) return null
      if (++failures >= MAX_FAILURES) return null
      await sleep(Math.min(1000 * 2 ** failures, 15_000), signal)
    }
  }
  return null
}

export function apply(ctx) {
  const remembered = new Map()
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.callId !== undefined) {
      remembered.delete(exec.callId)
      remembered.set(exec.callId, exec.arguments)
      if (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value)
    }
    return next()
  })

  const relayed = new WeakSet()
  const warn = (text) => ctx.logger?.warn?.(`kriya approvals: ${text}`)

  async function answer(carrier, req, device) {
    const stop = new AbortController()
    const signal = req.signal ? AbortSignal.any([req.signal, stop.signal]) : stop.signal
    const cwd = (() => {
      try {
        return ctx.get("workingDirectory")?.get(req.agent.session)
      } catch {
        return undefined
      }
    })()
    let asked
    try {
      asked = await call(device.url, "POST", "/approvals", {
        token: device.token,
        body: {
          sessionRef: String(req.agent?.sessionId ?? "").slice(0, 100),
          tool: req.toolName.slice(0, 60),
          summary: (req.reason || req.displayReason?.en || `Run ${req.toolName}`).slice(0, MAX_SUMMARY),
          input: inputFor(req.callId === undefined ? undefined : remembered.get(req.callId)),
          ...(typeof cwd === "string" && cwd && { cwd: cwd.length > 300 ? `…${cwd.slice(-299)}` : cwd }),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
    } catch (error) {
      // Kriya is unreachable or refused: only the local prompt can answer
      warn(`couldn't ask Kriya (${error.code ?? "error"}); answer here`)
      return null
    }
    if (req.callId !== undefined) remembered.delete(req.callId)

    const local = {
      ...req,
      signal,
      displayReason: {
        ...req.displayReason,
        en: [req.displayReason?.en ?? req.reason, PHONE_LINE].filter(Boolean).join("\n\n"),
      },
    }
    relayed.add(local)
    const here = Promise.resolve()
      .then(() => ctx.waterfall(carrier, "approval/request", local, () => Promise.resolve("unavailable")))
      .catch(() => "unavailable")
    const phone = phoneAnswer(device, asked.id, signal)
    let phoneDecided = false
    try {
      // The first decisive answer wins; "unavailable" here and none from the
      // phone mean the other side may still answer
      return await new Promise((resolve) => {
        let pending = 2
        const none = () => --pending === 0 && resolve("unavailable")
        here.then((outcome) => {
          if (outcome !== "unavailable") return resolve(outcome)
          if (!signal.aborted)
            process.stderr.write(`kriya: ${req.toolName} needs your OK. Waiting for your answer in Kriya on your phone.\n`)
          none()
        })
        phone.then((outcome) => {
          if (outcome === null) return none()
          phoneDecided = true
          resolve(outcome)
        })
      })
    } finally {
      // Withdraws whichever side lost; a request the phone didn't decide is canceled on Kriya
      stop.abort()
      if (!phoneDecided)
        call(device.url, "DELETE", `/approvals/${asked.id}`, {
          token: device.token,
          signal: AbortSignal.timeout(5_000),
        }).catch((error) => warn(`couldn't cancel on Kriya (${error.code ?? "error"})`))
    }
  }

  ctx.on(
    "approval/request",
    function (req, next) {
      // Our own copy, sent down the chain: the rest of the answerers decide it
      if (relayed.has(req)) return next()
      const device = deviceFromEnv()
      if (!device) return next()
      return answer(this, req, device).then((outcome) => outcome ?? next())
    },
    { prepend: true }
  )
}
