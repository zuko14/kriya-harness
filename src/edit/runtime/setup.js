// `kriya edit setup`: installs a signed runtime into ~/.kriya/media/<version>/.
// Versions sit side by side; `.complete` is written last and `current.json` moves
// only after it, so a failed install never touches the working version.

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs"
import { once } from "node:events"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { kriyaHome } from "../../paths.js"
import { manifestLicenceProblems } from "./licences.js"
import { fileSha256, RuntimeError } from "./manifest.js"

const exec = promisify(execFile)
const GB = 1e9

export const platformId = () => `${process.platform}-${process.arch}`
export const mediaRoot = (home = kriyaHome()) => join(home, "media")

/** A child's environment, built from scratch: nothing of Kriya's is inherited (ES-23). */
export function childEnv(home = kriyaHome(), env = process.env) {
  const root = mediaRoot(home)
  return { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, UV_CACHE_DIR: join(root, ".downloads", "uv"), UV_PYTHON_INSTALL_DIR: join(root, ".python"), UV_NO_CONFIG: "1" }
}

export const runChild = (home) => async (command, args) => (await exec(command, args, { env: childEnv(home), maxBuffer: 64 * 1024 * 1024 })).stdout

const freeBytes = (dir) => {
  const { bavail, bsize } = statfsSync(dir)
  return Number(bavail) * Number(bsize)
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0)
const textHash = (text) => createHash("sha256").update(text).digest("hex")

async function fetchFrom(artifact, offset) {
  const stopped = () => new RuntimeError(`The download of ${artifact.id} stopped. Run kriya edit setup again to resume.`)
  let response
  try {
    response = await fetch(artifact.url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} })
  } catch {
    throw stopped()
  }
  if (!response.ok) throw new RuntimeError(`The download of ${artifact.id} failed: its host answered ${response.status}.`)
  return { response, stopped }
}

/** Downloads to `part`, resuming what's there. The hash decides; a wrong file is deleted. */
async function download(artifact, part, onBytes = () => {}) {
  let offset = sizeOf(part)
  if (offset > artifact.bytes) {
    rmSync(part)
    offset = 0
  }
  if (offset < artifact.bytes) {
    const { response, stopped } = await fetchFrom(artifact, offset)
    // A host that ignores Range sends the whole file: start over
    const resumed = response.status === 206
    let written = resumed ? offset : 0
    const out = createWriteStream(part, { flags: resumed ? "a" : "w" })
    let tooLong = false
    let cut = false
    try {
      for await (const chunk of response.body) {
        written += chunk.length
        if (written > artifact.bytes) {
          tooLong = true
          break
        }
        if (!out.write(chunk)) await once(out, "drain")
        onBytes(written)
      }
    } catch {
      cut = true
    }
    out.end()
    await once(out, "close")
    if (tooLong) {
      rmSync(part)
      throw new RuntimeError(`The download of ${artifact.id} is larger than the manifest says, so it was deleted.`)
    }
    if (cut) throw stopped()
  }
  if ((await fileSha256(part)) !== artifact.sha256) {
    rmSync(part)
    throw new RuntimeError(`The download of ${artifact.id} doesn't match its hash, so it was deleted. Nothing was installed.`)
  }
}

async function placeArtifact(artifact, root, dir, home, say, progress = () => {}) {
  say(`Downloading ${artifact.id} ${artifact.version} (${(artifact.bytes / 1e6).toFixed(0)} MB)`)
  const part = join(root, ".downloads", `${artifact.sha256}.part`)
  progress({ step: artifact.id, done: sizeOf(part), total: artifact.bytes })
  await download(artifact, part, (done) => progress({ step: artifact.id, done, total: artifact.bytes }))
  const target = join(dir, artifact.id)
  mkdirSync(target, { recursive: true })
  if (artifact.unpack === "zip") await runChild(home)("unzip", ["-q", "-o", part, "-d", target])
  else cpSync(part, join(target, artifact.entry))
  rmSync(part)
}

async function placePython(python, dir, run, say, progress) {
  say(`Installing the ${python.id} environment (Python ${python.version}, ${python.packages.length} packages)`)
  progress({ step: python.id, done: null, total: null })
  const lock = join(dir, `${python.id}.lock`)
  writeFileSync(lock, python.requirements)
  const venv = join(dir, "python")
  const interpreter = join(venv, "bin", "python")
  await run("uv", ["venv", "--python", python.version, venv])
  await run("uv", ["pip", "install", "--python", interpreter, "--require-hashes", "--only-binary", ":all:", "--index-url", "https://pypi.org/simple", "-r", lock])
  await run(interpreter, ["-c", `import ${python.check}`])
}

const pointerFile = (root) => join(root, "current.json")

function readPointer(root) {
  try {
    return JSON.parse(readFileSync(pointerFile(root), "utf8"))
  } catch {
    return { current: null, previous: null }
  }
}

function writePointer(root, pointer) {
  const file = pointerFile(root)
  writeFileSync(`${file}.new`, JSON.stringify(pointer))
  renameSync(`${file}.new`, file)
}

const complete = (dir) => existsSync(join(dir, ".complete"))

/** The installed runtime in use, or null. */
export function activeRuntime(home = kriyaHome()) {
  const root = mediaRoot(home)
  const { current } = readPointer(root)
  if (!current || !complete(join(root, current))) return null
  const dir = join(root, current)
  return { version: current, dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) }
}

/** Swaps to the version used before. Both stay on disk, so it can be undone the same way. */
export function rollback(home = kriyaHome()) {
  const root = mediaRoot(home)
  const { current, previous } = readPointer(root)
  if (!previous || !complete(join(root, previous))) throw new RuntimeError("There is nothing to roll back to.")
  writePointer(root, { current: previous, previous: current })
  return activeRuntime(home)
}

function use(root, version) {
  const { current } = readPointer(root)
  if (current !== version) writePointer(root, { current: version, previous: current })
}

/**
 * @param {{ text: string, data: object }} opened from openManifest
 * @param {{ home?: string, platform?: string, run?: (command: string, args: string[]) => Promise<string>, free?: (dir: string) => number, say?: (line: string) => void, progress?: (at: { step: string, done: number | null, total: number | null }) => void }} [options]
 *   progress: bytes of each download as they arrive, for the Studio's progress bar
 */
export async function install({ text, data }, { home = kriyaHome(), platform = platformId(), run = runChild(home), free = freeBytes, say = () => {}, progress = () => {} } = {}) {
  const spec = data.platforms[platform]
  if (!spec) throw new RuntimeError(`This runtime isn't available for this computer (${platform}) yet.`)
  refuseLicences(data)
  const root = mediaRoot(home)
  const dir = join(root, data.version)
  mkdirSync(join(root, ".downloads"), { recursive: true })

  const hash = textHash(text)
  if (complete(dir) && readFileSync(join(dir, ".complete"), "utf8") === hash) {
    use(root, data.version)
    say(`Media Runtime ${data.version} is already installed.`)
    return activeRuntime(home)
  }

  try {
    await run("uv", ["--version"])
  } catch {
    throw new RuntimeError(`uv isn't installed: ${spec.system.find((tool) => tool.id === "uv")?.fix ?? "install uv"}.`)
  }
  // An archive and its unpacked copy exist at once, and unpack to about twice its size
  const needed = spec.artifacts.reduce((sum, artifact) => sum + artifact.bytes * 3, spec.python.estimateBytes)
  const available = free(dirname(dir))
  if (available < needed) throw new RuntimeError(`This needs about ${(needed / GB).toFixed(1)} GB free, and there are ${(available / GB).toFixed(1)} GB.`)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    for (const artifact of spec.artifacts) await placeArtifact(artifact, root, dir, home, say, progress)
    await placePython(spec.python, dir, run, say, progress)
    writeFileSync(join(dir, "manifest.json"), text)
    writeFileSync(join(dir, ".complete"), hash)
    // The environment no longer needs it, and it's as big as the environment
    rmSync(childEnv(home).UV_CACHE_DIR, { recursive: true, force: true })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  use(root, data.version)
  say(`Media Runtime ${data.version} is ready.`)
  return activeRuntime(home)
}

// The licence gate (ET-LIC-01) before anything is downloaded
function refuseLicences(data) {
  const problems = manifestLicenceProblems(data)
  if (problems.length) throw new RuntimeError(`This runtime has an item outside Kriya's licence table, so nothing was installed: ${problems[0].item}, ${problems[0].problem}.`)
}

/**
 * Installs one capability pack (CAPABILITY_PACKS) into the runtime in use, from the
 * same signed manifest: its files go to <version>/packs/<id>/, `.complete` last. The
 * core is never touched; a failure removes only the pack's own folder.
 * @param {{ text: string, data: object }} opened from openManifest
 */
export async function installPack({ text, data }, id, { home = kriyaHome(), platform = platformId(), free = freeBytes, say = () => {} } = {}) {
  const runtime = activeRuntime(home)
  if (!runtime) throw new RuntimeError("Install the Media Runtime first: kriya edit setup.")
  if (runtime.version !== data.version) throw new RuntimeError(`Kriya now serves Media Runtime ${data.version}; run kriya edit setup first, then add the pack.`)
  const pack = data.platforms[platform]?.packs?.[id]
  if (!pack) throw new RuntimeError(`Media Runtime ${data.version} doesn't offer ${id} for this computer (${platform}).`)
  refuseLicences(data)
  const root = mediaRoot(home)
  const dir = join(runtime.dir, "packs", id)
  const hash = textHash(`${textHash(text)}:${id}`)
  if (complete(dir) && readFileSync(join(dir, ".complete"), "utf8") === hash) {
    say(`The ${id} pack is already installed.`)
    return dir
  }
  const needed = pack.artifacts.reduce((sum, artifact) => sum + artifact.bytes * 3, 0)
  const available = free(dirname(dir))
  if (available < needed) throw new RuntimeError(`This pack needs about ${(needed / GB).toFixed(1)} GB free, and there are ${(available / GB).toFixed(1)} GB.`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(root, ".downloads"), { recursive: true })
  mkdirSync(dir, { recursive: true })
  try {
    for (const artifact of pack.artifacts) await placeArtifact(artifact, root, dir, home, say)
    writeFileSync(join(dir, ".complete"), hash)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  say(`The ${id} pack is ready.`)
  return dir
}

/** Removes one pack from the runtime in use; the core and other packs stay. */
export function removePack(id, { home = kriyaHome() } = {}) {
  if (!/^pack-[a-z0-9-]+$/.test(id)) throw new RuntimeError("That isn't a pack's name.")
  const runtime = activeRuntime(home)
  const dir = runtime && join(runtime.dir, "packs", id)
  if (!dir || !existsSync(dir)) throw new RuntimeError(`The ${id} pack isn't installed.`)
  rmSync(dir, { recursive: true, force: true })
  return dir
}
