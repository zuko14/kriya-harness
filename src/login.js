import { spawn } from "node:child_process"
import { hostname } from "node:os"

import { deviceCode, deviceToken, KriyaError, me } from "./api.js"
import { writeDevice } from "./store.js"

// `kriya login` (P-AUTH, HD-05): the device flow. Ask for a code, show it
// and open the connect page, poll until the person approves it in their
// signed-in browser, keep the token (shown once) on this machine, then say
// who we're signed in as. The device never approves itself.

/** A device name the server accepts: 1–60 printable characters. */
export function deviceName() {
  const name = hostname().replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60)
  return name || "My computer"
}

/** The connect page, with the code filled in so the person only confirms it. */
export function connectUrl(verificationUrl, userCode) {
  const url = new URL(verificationUrl)
  url.searchParams.set("code", userCode)
  return url.toString()
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref()
  } catch {
    // No browser here (a server, SSH): the printed link is enough
  }
}

/**
 * @param {string} url Kriya origin
 * @param {{ say?: (line: string) => void, sleep?: (ms: number) => Promise<void>, browser?: boolean, now?: () => number }} [io]
 */
export async function login(url, io = {}) {
  const say = io.say ?? ((line) => process.stdout.write(`${line}\n`))
  const sleep = io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
  const now = io.now ?? Date.now
  const platform = ["darwin", "linux", "win32"].includes(process.platform) ? process.platform : "linux"

  const code = await deviceCode(url, { deviceName: deviceName(), platform })
  const link = connectUrl(code.verificationUrl, code.userCode)
  say(
    `Open ${code.verificationUrl} and enter ${code.userCode} (expires in ${Math.round(code.expiresIn / 60)} minutes).`
  )
  if (io.browser !== false) openBrowser(link)

  const deadline = now() + code.expiresIn * 1000
  let interval = code.interval * 1000
  for (;;) {
    await sleep(interval)
    if (now() > deadline) throw new KriyaError(410, "expired", "The code expired. Run kriya login again.")
    try {
      const { token, deviceId } = await deviceToken(url, code.deviceCode)
      writeDevice({ url, token, deviceId })
      const who = await me(url, token)
      say(`Signed in as ${who.displayName ?? "you"} · working as ${who.agent?.name ?? "your agent"}.`)
      return { token, deviceId, me: who }
    } catch (error) {
      if (!(error instanceof KriyaError)) throw error
      if (error.code === "pending") continue
      // Kriya restarting (a deploy) while the person approves: keep waiting
      // until the code expires
      if (error.code === "network" || error.status >= 500) continue
      // Polled too fast: back off by the interval, as the device flow asks
      if (error.code === "rate_limited") {
        interval += code.interval * 1000
        continue
      }
      if (error.code === "denied") throw new KriyaError(403, "denied", "Sign-in was denied in Kriya.")
      throw error
    }
  }
}
