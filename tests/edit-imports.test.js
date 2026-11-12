import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { test } from "node:test"

import { ROOT } from "./helpers.js"

// ET-IMP-01: ARCHITECTURE §6, followed through every import, not just the first hop.

const IMPORT = /\b(?:import|export)\s[^"'`]*?from\s*["'`]([^"'`]+)|\bimport\s*\(\s*["'`]([^"'`]+)|\bimport\s*["'`]([^"'`]+)/g

const filesIn = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : entry.name.endsWith(".js") ? [join(dir, entry.name)] : []))

const importsOf = (file) => [...readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3])

/** Every file and package a file reaches. */
function reach(start) {
  const seen = new Set()
  const external = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const target of importsOf(file)) {
      if (target.startsWith(".")) walk(relative(ROOT, resolve(join(ROOT, dirname(file)), target)))
      else external.add(target)
    }
  }
  walk(start)
  return { files: [...seen], external: [...external] }
}

const under = (dir) => filesIn(dir).map((file) => reach(file))

test("ET-IMP-01: the Engine never reaches the gateway, the API client or the coding loop", () => {
  for (const { files } of under("src/edit/engine")) {
    for (const file of files) assert.doesNotMatch(file, /src\/(api|gateway-proxy|loop|verify|checkpoints|world|daemon)\.js$/, file)
  }
})

test("ET-IMP-01: the graph knows nothing of what a node means", () => {
  for (const { files, external } of under("src/edit/graph")) {
    for (const file of files) assert.ok(file.startsWith("src/edit/graph/"), file)
    for (const name of external) assert.ok(name.startsWith("node:"), name)
  }
})

test("ET-IMP-01: the Host reaches no coding-loop file, and src/edit adds no package", () => {
  for (const { files } of under("src/edit/host")) {
    for (const file of files) assert.doesNotMatch(file, /src\/(loop|verify|checkpoints|world|daemon)\.js$/, file)
  }
  for (const dir of ["src/edit/host", "src/edit/engine", "src/edit/graph", "src/edit/core"]) {
    for (const { external } of under(dir)) {
      // playwright-core is the harness's own pinned dependency (src/browser.js); engine/motion.js measures text with it, lazily (ED8)
      for (const name of external) assert.ok(name.startsWith("node:") || name === "playwright-core", `${dir}: ${name}`)
    }
  }
})

// The lazy lines behind the switch: `kriya edit`, the Studio row's route (ED6), and the
// daemon's handover of a job from Kriya (ED14)
const LAZY = new Set(["bin/kriya.js ../src/edit/runtime/cli.js", "plugins/edit/index.js ../../src/edit/host/client.js", "src/daemon.js ./edit/host/client.js", "src/daemon.js ./edit/host/watch.js", /* TP11: clip numbers and the features answer, only with KRIYA_EDIT on and editing advertised */ "src/daemon.js ./edit/host/clips.js", "src/daemon.js ./edit/runtime/fetch.js"])

test("ET-IMP-01: only the lazy lines in bin/kriya.js, plugins/edit and the daemon reach src/edit from outside it", () => {
  for (const dir of ["src", "plugins", "scripts", "bin"]) {
    for (const file of filesIn(dir)) {
      if (file.startsWith("src/edit/") || file.endsWith(".bundle.js")) continue
      for (const target of importsOf(file)) {
        if (target.includes("/edit/")) assert.ok(LAZY.has(`${file} ${target}`), `${file} ${target}`)
      }
    }
  }
  assert.match(readFileSync(join(ROOT, "bin", "kriya.js"), "utf8"), /await import\("\.\.\/src\/edit\/runtime\/cli\.js"\)/)
  assert.match(readFileSync(join(ROOT, "plugins", "edit", "index.js"), "utf8"), /\(\) => import\("\.\.\/\.\.\/src\/edit\/host\/client\.js"\)/)
  assert.doesNotMatch(readFileSync(join(ROOT, "plugins", "edit", "index.js"), "utf8"), /^import .*src\/edit/m, "no static import")
  assert.doesNotMatch(readFileSync(join(ROOT, "src", "daemon.js"), "utf8"), /^import .*\.\/edit\//m, "no static import")
})

test("ET-IMP-01: the Studio app reaches nothing outside studio/src", () => {
  for (const file of filesIn("studio/src")) {
    for (const target of importsOf(file)) assert.ok(target.startsWith("./") && !target.includes(".."), `${file} imports ${target}`)
  }
})
