// The motion layer's runtime for the media tests (ED8): the pinned HyperFrames CLI
// and the manifest's Chrome, linked into a test Media Runtime. The real runtime
// brings both in a signed manifest version (EB-09); until then
// `tests/edit/media/setup-hyperframes.sh` installs them once.

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { confinement } from "../../../src/edit/engine/confine.js"

export const HYPERFRAMES_VERSION = "0.9.20"
export const CHROME_VERSION = "152.0.7977.30" // the 2026.11.0 manifest's chrome-headless-shell
const ENTRY = "chrome-headless-shell-mac-arm64/chrome-headless-shell"

const hyperframesDir = () => process.env.KRIYA_EDIT_HYPERFRAMES ?? join(homedir(), ".cache", "kriya-edit-test", `hyperframes-${HYPERFRAMES_VERSION}`)

function chromeDir() {
  const roots = [process.env.KRIYA_EDIT_CHROME, join(homedir(), ".cache", "kriya-edit-test", "chrome", "chrome-headless-shell"), join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell")].filter(Boolean)
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = readdirSync(root).find((name) => name.endsWith(CHROME_VERSION) && existsSync(join(root, name, ENTRY)))
    if (found) return join(root, found)
  }
  return null
}

/** Why these tests can't run here, or false. */
export function motionSkip() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "the motion layer is confined on macOS arm64 only so far"
  if (!confinement().kind) return "no OS sandbox on this computer"
  if (!existsSync(join(hyperframesDir(), "node_modules", "hyperframes", "bin", "hyperframes.mjs"))) return `no HyperFrames ${HYPERFRAMES_VERSION}: run tests/edit/media/setup-hyperframes.sh`
  if (!chromeDir()) return `no chrome-headless-shell ${CHROME_VERSION}: run tests/edit/media/setup-hyperframes.sh`
  return false
}

/** Why a Chrome-only test can't run here, or false. */
export function chromeSkip() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "the motion layer is confined on macOS arm64 only so far"
  if (!confinement().kind) return "no OS sandbox on this computer"
  if (!chromeDir()) return `no chrome-headless-shell ${CHROME_VERSION}: run tests/edit/media/setup-hyperframes.sh`
  return false
}

export const MANIFEST = { schema: 1, version: "9.9.9", platforms: { "darwin-arm64": { artifacts: [{ id: "chrome-headless-shell", entry: ENTRY }] } } }

/** Links HyperFrames and Chrome into `<home>/media/9.9.9` and returns it as activeRuntime() would. */
export function linkMotion(home, { manifest = MANIFEST, hyperframes = true } = {}) {
  const dir = join(home, "media", "9.9.9")
  mkdirSync(dir, { recursive: true })
  // hyperframes: false is the signed 2026.11.0 runtime: Chrome only, so tiles draw in Chrome
  if (hyperframes && !existsSync(join(dir, "hyperframes"))) symlinkSync(hyperframesDir(), join(dir, "hyperframes"))
  if (!existsSync(join(dir, "chrome-headless-shell"))) symlinkSync(chromeDir(), join(dir, "chrome-headless-shell"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(dir, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
  return { version: "9.9.9", dir, manifest }
}

/* TP7: the font pack, from the files setup-hyperframes.sh keeps by hash */
const FONT_MANIFEST = JSON.parse(readFileSync(new URL("../runtime-2026.11.1.json", import.meta.url), "utf8")).platforms["darwin-arm64"].packs["pack-fonts"]
const fontFile = (artifact) => join(homedir(), ".cache", "kriya-edit-test", "fonts", `${artifact.sha256}.ttf`)

/** Why the font tests can't run here, or false. */
export function fontsSkip() {
  const missing = FONT_MANIFEST.artifacts.find((a) => !existsSync(fontFile(a)))
  return chromeSkip() || (missing ? `no ${missing.id} in ~/.cache/kriya-edit-test/fonts: run tests/edit/media/setup-hyperframes.sh` : false)
}

/** linkMotion, with the font pack installed in it as \`kriya edit setup --pack fonts\` leaves it. */
export function linkFonts(home, options = {}) {
  const manifest = { ...MANIFEST, platforms: { "darwin-arm64": { ...MANIFEST.platforms["darwin-arm64"], packs: { "pack-fonts": FONT_MANIFEST } } } }
  const runtime = linkMotion(home, { ...options, manifest })
  const dir = join(runtime.dir, "packs", "pack-fonts")
  for (const artifact of FONT_MANIFEST.artifacts) {
    mkdirSync(join(dir, artifact.id), { recursive: true })
    if (!existsSync(join(dir, artifact.id, artifact.entry))) symlinkSync(fontFile(artifact), join(dir, artifact.id, artifact.entry))
  }
  writeFileSync(join(dir, ".complete"), "test")
  return runtime
}
