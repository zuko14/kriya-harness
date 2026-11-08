// `kriya edit doctor`: what this computer has for editing, each with a plain fix.
// Exit code 0 only when every check passes, as `kriya doctor`.

import { accessSync, constants, existsSync, statfsSync } from "node:fs"
import { cpus, totalmem } from "node:os"
import { dirname, join } from "node:path"

import { syncedFolder } from "../../doctor.js"
import { kriyaHome } from "../../paths.js"
import { activeRuntime, platformId, runChild } from "./setup.js"

const SUPPORTED = ["darwin-arm64"]
// EX-09 measured about 4.8 GB for everything on a Mac
const MIN_FREE = 5e9
// Used until a runtime is installed; after that its manifest decides
const SYSTEM = [
  { id: "ffmpeg", minVersion: "6.0", fix: "brew install ffmpeg" },
  { id: "uv", minVersion: "0.13.0", fix: "brew install uv" },
]
const HARDWARE_ENCODERS = ["h264_videotoolbox", "hevc_videotoolbox"]

const older = (version, minimum) => {
  if (!/^\d/.test(version)) return false // a development build names no number to compare
  const [a, b] = [version, minimum].map((v) => v.split(".").map((part) => Number.parseInt(part, 10) || 0))
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

const attempt = async (run, command, args) => {
  try {
    return await run(command, args)
  } catch {
    return null
  }
}

const versionOf = (output) => /version (\S+)/.exec(output ?? "")?.[1] ?? null

// shortcut: 16 GB is a judgement, not a measurement, EX runs on a slower laptop (SPIKES §3) should settle it
export const hardwareTier = ({ memory, metal }) => (metal && memory >= 16 * 2 ** 30 ? "standard" : "core")

function nearestFolder(path) {
  let dir = path
  while (!existsSync(dir)) dir = dirname(dir)
  return dir
}

const freeBytes = (dir) => {
  const { bavail, bsize } = statfsSync(nearestFolder(dir))
  return Number(bavail) * Number(bsize)
}

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** @returns {Promise<{ ok: boolean, ffmpeg: string | null, encoders: string[], metal: boolean, tier: string, runtime: string | null }>} */
export async function checkRuntime({ home = kriyaHome(), platform = platformId(), run = runChild(home), free = freeBytes, memory = totalmem(), cpu = cpus()[0]?.model ?? "unknown", cwd = process.cwd(), say = (line) => process.stdout.write(`${line}\n`) } = {}) {
  let ok = true
  const check = (pass, label, fix) => {
    ok &&= pass
    say(`${pass ? "ok  " : "FAIL"}  ${label}${pass || !fix ? "" : ` — ${fix}`}`)
  }

  check(SUPPORTED.includes(platform), `computer: ${platform}`, "macOS on Apple silicon comes first; this one isn't supported yet")

  const runtime = activeRuntime(home)
  const spec = runtime?.manifest.platforms[platform]
  const system = spec?.system ?? SYSTEM
  const need = (id) => system.find((tool) => tool.id === id)

  const ffmpeg = versionOf(await attempt(run, "ffmpeg", ["-version"]))
  const ffprobe = versionOf(await attempt(run, "ffprobe", ["-version"]))
  const { minVersion, fix } = need("ffmpeg")
  if (!ffmpeg) check(false, "FFmpeg", fix)
  else if (older(ffmpeg, minVersion)) check(false, `FFmpeg ${ffmpeg} is older than ${minVersion}`, fix)
  else if (ffprobe !== ffmpeg) check(false, `ffprobe ${ffprobe ?? "is missing and"} doesn't match FFmpeg ${ffmpeg}`, fix)
  else check(true, `FFmpeg ${ffmpeg}`)

  const list = ffmpeg ? ((await attempt(run, "ffmpeg", ["-hide_banner", "-encoders"])) ?? "") : ""
  const encoders = HARDWARE_ENCODERS.filter((name) => new RegExp(`\\b${name}\\b`).test(list))
  if (encoders.length) check(true, `hardware encoders: ${encoders.join(", ")}`)
  else if (ffmpeg) say("note  no hardware encoder in this FFmpeg, so drafts render on the CPU")

  // Homebrew's plain ffmpeg has neither (EF-37): captions go through tiles, and HDR through a LUT
  const filters = ffmpeg ? await attempt(run, "ffmpeg", ["-hide_banner", "-filters"]) : null
  if (filters && !/\bdrawtext\b/.test(filters)) say("note  this FFmpeg has no drawtext, so captions render as tiles (ED8), not burned in directly")

  const uv = /^uv (\S+)/.exec((await attempt(run, "uv", ["--version"])) ?? "")?.[1]
  const needUv = need("uv")
  check(!!uv && !older(uv, needUv.minVersion), uv ? `uv ${uv}` : "uv", needUv.fix)

  const display = platform.startsWith("darwin") ? await attempt(run, "system_profiler", ["SPDisplaysDataType"]) : null
  const metal = /Metal/.test(display ?? "")
  if (metal) check(true, "Metal")
  else say("note  no Metal GPU found; heavy layers stay off")

  const tier = hardwareTier({ memory, metal })
  say(`ok    machine: ${cpu}, ${Math.round(memory / 2 ** 30)} GB memory`)
  say(`ok    hardware tier: ${tier}`)

  const available = free(home)
  check(available >= MIN_FREE, `disk: ${(available / 1e9).toFixed(0)} GB free`, `the runtime and its cache need about ${(MIN_FREE / 1e9).toFixed(0)} GB`)

  if (!runtime || !spec) check(false, "Media Runtime", "run kriya edit setup")
  else {
    check(true, `Media Runtime ${runtime.version}`)
    for (const artifact of spec.artifacts) check(executable(join(runtime.dir, artifact.id, artifact.entry)), `${artifact.id} ${artifact.version}`, "run kriya edit setup")
    const { id, check: module } = spec.python
    const imported = await attempt(run, join(runtime.dir, "python", "bin", "python"), ["-c", `import ${module}`])
    check(imported !== null, `${id}: ${module}`, "run kriya edit setup")
  }

  const synced = syncedFolder(cwd)
  if (synced) say(`note  ${synced}`)
  return { ok, ffmpeg, encoders, metal, tier, runtime: runtime?.version ?? null }
}
