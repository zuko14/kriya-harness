// `kriya edit setup` and `kriya edit doctor`, loaded only with the switch on.

import { spawn } from "node:child_process"

import { KriyaError } from "../../api.js"
import { kriyaHome } from "../../paths.js"
import { readDevice } from "../../store.js"
import { checkRuntime } from "./doctor.js"
import { fetchManifest } from "./fetch.js"
import { RuntimeError } from "./manifest.js"
import { install, installPack, removePack, rollback } from "./setup.js"

const USAGE = `Usage:
  kriya edit [--no-open]          open the Editing Studio in your browser (--no-open: only print its link)
  kriya edit setup [--rollback]   install the Media Runtime, or go back to the last one
  kriya edit setup --pack <name>  add a capability pack (color, voice-clean, depth)
  kriya edit setup --remove-pack <name>
                                  remove one; the rest of the runtime stays
  kriya edit doctor               what this computer has for editing
  kriya edit verify <file> [--receipt <file>]
                                  re-measure an export against its receipt
  kriya edit replay <job>         re-run a make job from its recording, with no model call
  kriya edit watch [<folder>]     tell Kriya about new recordings there (name and duration only);
                                  with no folder, list them. Nothing runs until you tap the card
  kriya edit unwatch <folder>     stop`

/** The Studio's one-time link in the person's own browser, as `kriya login` opens its page. No browser: the printed link is enough. */
export function openInBrowser(url, { platform = process.platform, run = spawn } = {}) {
  const [command, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    run(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref()
    return true
  } catch {
    return false
  }
}

export async function editCommand([action, ...rest], { say = (line) => process.stdout.write(`${line}\n`), open = openInBrowser, interactive = process.stdout.isTTY === true, host = () => import("../host/client.js") } = {}) {
  try {
    // Typed in a terminal, `kriya edit` opens the Studio itself, never the harness's Web UI. Piped (a script)
    // or with --no-open, it prints only the link, as it always did
    if (action === undefined || (action === "--no-open" && rest.length === 0)) {
      const { ensureHost, hostCall } = await host()
      await ensureHost()
      const { url } = await hostCall(kriyaHome(), "POST", "/internal/launch")
      if (action === "--no-open" || !interactive) {
        say(url)
        return 0
      }
      say(`Opening the Kriya Editing Studio in your browser. If it didn't open, this link works once, for a short while:\n${url}`)
      open(url)
      return 0
    }
    if ((action === "watch" && rest.length <= 1) || (action === "unwatch" && rest.length === 1)) {
      const { unwatchFolder, watchedFolders, watchFolder } = await import("../host/watch.js")
      const { ensureHost } = await import("../host/client.js")
      const home = kriyaHome()
      if (action === "unwatch") {
        say(unwatchFolder(rest[0], { home }) ? `Stopped watching ${rest[0]}.` : "That folder wasn't being watched.")
        return 0
      }
      if (!rest.length) {
        const folders = watchedFolders({ home })
        say(folders.length ? folders.join("\n") : "No folder is being watched.")
        return 0
      }
      try {
        const folder = watchFolder(rest[0], { home })
        await ensureHost()
        say(`Watching ${folder}. What's there now counts as old. It needs to be a folder \`kriya daemon\` offers.`)
        return 0
      } catch (error) {
        say(error.code === "ENOENT" ? "There's no such folder." : error.message)
        return 1
      }
    }
    if (action === "doctor" && rest.length === 0) return (await checkRuntime({ say })).ok ? 0 : 1
    if (action === "verify" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--receipt"))) return await verifyCommand(rest[0], rest[2], say)
    if (action === "replay" && rest.length === 1) return await replayCommand(rest[0], say)
    if (action === "setup" && rest.length === 1 && rest[0] === "--rollback") {
      say(`Back on Media Runtime ${rollback().version}.`)
      return 0
    }
    if (action === "setup" && rest.length === 2 && rest[0] === "--remove-pack") {
      removePack(`pack-${rest[1]}`)
      say(`Removed the ${rest[1]} pack.`)
      return 0
    }
    if (action === "setup" && rest.length === 2 && rest[0] === "--pack") {
      const { PACKS } = await import("../engine/packs.js")
      const pack = PACKS[`pack-${rest[1]}`]
      if (!pack) return say(`There is no ${rest[1]} pack. Packs: ${Object.keys(PACKS).map((id) => id.slice(5)).join(", ")}.`), 1
      if (!pack.artifacts.length) return say(`The ${pack.title} pack comes with FFmpeg; there is nothing to download. kriya edit doctor says whether this FFmpeg has what it needs.`), 0
      const device = readDevice()
      if (!device) {
        say("Run `kriya login` to connect your Kriya account.")
        return 1
      }
      await installPack(await fetchManifest(device), `pack-${rest[1]}`, { say })
      return 0
    }
    if (action === "setup" && rest.length === 0) {
      const device = readDevice()
      if (!device) {
        say("Run `kriya login` to connect your Kriya account.")
        return 1
      }
      await install(await fetchManifest(device), { say })
      return 0
    }
    say(USAGE)
    return 1
  } catch (error) {
    if (!(error instanceof RuntimeError || error instanceof KriyaError)) throw error
    say(error.message)
    return 1
  }
}

async function verifyCommand(file, receiptFile, say) {
  const { existsSync } = await import("node:fs")
  const { readReceipt, receiptPath, verifyFile } = await import("../engine/receipt.js")
  const receipt = receiptFile ?? receiptPath(file)
  if (!existsSync(file)) return say(`There is no file ${file}.`), 1
  if (!existsSync(receipt)) return say(`There is no receipt at ${receipt}.`), 1
  const result = await verifyFile(file, readReceipt(receipt))
  if (result.ok) say(`${file} is the file its receipt describes, byte for byte.`)
  else for (const line of [`${file} doesn't match its receipt:`, ...result.differences.map((d) => `  ${d}`)]) say(line)
  return result.ok ? 0 : 1
}

async function replayCommand(job, say) {
  const { ensureHost, hostCall } = await import("../host/client.js")
  await ensureHost()
  const started = await hostCall(kriyaHome(), "POST", `/jobs/${job}/replay`)
  for (;;) {
    const row = (await hostCall(kriyaHome(), "GET", "/jobs")).jobs.find((j) => j.id === started.id)
    if (row && ["done", "failed", "canceled"].includes(row.status)) {
      if (row.status !== "done") return say(`The replay ${row.status}: ${row.error ?? ""}`.trim()), 1
      const result = JSON.parse(row.output)
      say(`Replayed ${result.replayOf} with no model call: verdict ${result.verdict}.`)
      for (const line of result.same ? ["Same verdict, plan and gates as the first run."] : ["It differs from the first run:", ...result.differences.map((d) => `  ${d}`)]) say(line)
      return result.same ? 0 : 1
    }
    await new Promise((done) => setTimeout(done, 500))
  }
}
