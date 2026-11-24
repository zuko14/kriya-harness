import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ROOT } from "./helpers.js"

// S-2 (install.sh; Kriya-Tavi docs/kriya-harness/INSTALLER.md): the one-line
// installer, run with fake curl, uname and npm. The real script is used, with
// one change made here only: its embedded Node checksum is set to the fake
// tarball's, so the product script carries no way to skip the check.

const SCRIPT = readFileSync(join(ROOT, "install.sh"), "utf8")
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const NODE = /^NODE_VERSION="([\d.]+)"$/m.exec(SCRIPT)[1]

function world({ os = "Darwin", arch = "arm64", corrupt = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-install-")))
  const home = join(dir, "home")
  const shims = join(dir, "shims")
  const log = join(dir, "log")
  mkdirSync(home)
  mkdirSync(shims)
  writeFileSync(log, "")
  // A Node release with a node that is the real one and an npm that records its call
  const target = `${os === "Darwin" ? "darwin" : "linux"}-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"}`
  const pkg = join(dir, "pkg", `node-v${NODE}-${target}`)
  mkdirSync(join(pkg, "bin"), { recursive: true })
  writeFileSync(join(pkg, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  writeFileSync(
    join(pkg, "bin", "npm"),
    `#!/bin/sh
echo "npm $*" >> "${log}"
prefix=""; last=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift ;; esac; last="$1"; shift; done
mkdir -p "$prefix/lib/node_modules/@kriya-ai/harness/bin"
printf '%s\\n' 'const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "kriya " + process.argv.slice(2).join(" ") + " home=" + process.env.KRIYA_HOME + "\\n")' > "$prefix/lib/node_modules/@kriya-ai/harness/bin/kriya.js"
`
  )
  for (const f of ["node", "npm"]) chmodSync(join(pkg, "bin", f), 0o755)
  const tarball = join(dir, `node-v${NODE}-${target}.tar.gz`)
  execFileSync("tar", ["-czf", tarball, "-C", join(dir, "pkg"), `node-v${NODE}-${target}`])
  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex")
  if (corrupt) writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("x")]))
  writeFileSync(join(shims, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "${os}" ;; -m) echo "${arch}" ;; *) echo "${os}" ;; esac\n`)
  writeFileSync(
    join(shims, "curl"),
    `#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done
echo "curl $url" >> "${log}"
case "$url" in https://nodejs.org/dist/v${NODE}/*) cp "${tarball}" "$out" ;; *) exit 22 ;; esac
`
  )
  for (const f of ["uname", "curl"]) chmodSync(join(shims, f), 0o755)
  // The real script, its four checksum lines set to the fake tarball's
  const script = join(dir, "install.sh")
  writeFileSync(script, SCRIPT.replace(/echo "[0-9a-f]{64}"/g, `echo "${sha}"`))
  const run = (env = {}) =>
    spawnSync("/bin/sh", [script], {
      env: { PATH: `${shims}:/usr/bin:/bin`, HOME: home, SHELL: "/bin/zsh", TMPDIR: dir, ...env },
      encoding: "utf8",
      input: "",
    })
  return { dir, home, log, run, lines: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) }
}

test("IN-01: installs a private Node and Kriya Harness, a working kriya, and one PATH line; a second run downloads nothing", () => {
  const w = world()
  const first = w.run()
  assert.equal(first.status, 0, first.stderr + first.stdout)
  const kriyaHome = join(w.home, ".kriya")
  assert.equal(statSync(kriyaHome).mode & 0o777, 0o700)
  assert.ok(existsSync(join(kriyaHome, "runtime", `node-v${NODE}-darwin-arm64`, "bin", "node")))
  assert.deepEqual(w.lines().filter((l) => l.startsWith("npm")), [`npm install --global --prefix ${kriyaHome}/npm --no-fund --no-audit --loglevel=error @kriya-ai/harness@${PKG.version}`])
  // The wrapper runs kriya on the private node, with the home it was installed to
  const ran = spawnSync(join(kriyaHome, "bin", "kriya"), ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: w.home }, encoding: "utf8" })
  assert.equal(ran.status, 0, ran.stderr)
  assert.ok(w.lines().includes(`kriya --version home=${kriyaHome}`), w.lines().join("\n"))
  const rc = readFileSync(join(w.home, ".zshrc"), "utf8")
  assert.equal(rc.match(/# Kriya Harness \(install.sh\)/g).length, 1)
  assert.ok(rc.includes(`export PATH="${kriyaHome}/bin:$PATH"`))
  assert.match(first.stdout, /Open a new terminal/)
  const second = w.run()
  assert.equal(second.status, 0, second.stderr)
  assert.equal(w.lines().filter((l) => l.startsWith("curl")).length, 1, "Node is downloaded once")
  assert.equal(readFileSync(join(w.home, ".zshrc"), "utf8").match(/# Kriya Harness \(install.sh\)/g).length, 1)
})

test("IN-02: a download that doesn't match its checksum installs nothing", () => {
  const w = world({ corrupt: true })
  const r = w.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /didn't match its published checksum; nothing was installed/)
  assert.equal(existsSync(join(w.home, ".kriya", "runtime", `node-v${NODE}-darwin-arm64`)), false)
  assert.equal(w.lines().some((l) => l.startsWith("npm")), false)
})

test("IN-03: Linux arm64 works; Windows and unknown processors get a plain sentence", () => {
  assert.equal(world({ os: "Linux", arch: "aarch64" }).run({ SHELL: "/bin/bash" }).status, 0)
  const win = world({ os: "MINGW64_NT-10.0" }).run()
  assert.equal(win.status, 1)
  assert.match(win.stderr, /inside WSL/)
  const odd = world({ arch: "riscv64" }).run()
  assert.equal(odd.status, 1)
  assert.match(odd.stderr, /No Kriya Harness build for riscv64/)
})

test("IN-04: signs in only to an https Kriya (or a local one), not when already signed in, not when asked not to", () => {
  const login = (w) => w.lines().filter((l) => l.startsWith("kriya login"))
  // As downloaded from a Kriya: its address filled in
  const served = world()
  writeFileSync(join(served.dir, "install.sh"), readFileSync(join(served.dir, "install.sh"), "utf8").replace("__KRIYA_URL__", "https://kriya.example"))
  assert.equal(served.run().status, 0)
  assert.deepEqual(login(served), [`kriya login --url https://kriya.example home=${join(served.home, ".kriya")}`])
  // The placeholder (the script from the repository): no sign-in
  const plain = world()
  assert.equal(plain.run().status, 0)
  assert.deepEqual(login(plain), [])
  // Not https: never
  const odd = world()
  assert.equal(odd.run({ KRIYA_URL: "http://kriya.example" }).status, 0)
  assert.deepEqual(login(odd), [])
  // Already signed in, or KRIYA_NO_LOGIN
  const signed = world()
  mkdirSync(join(signed.home, ".kriya"))
  writeFileSync(join(signed.home, ".kriya", "device.json"), "{}")
  const out = signed.run({ KRIYA_URL: "https://kriya.example" })
  assert.deepEqual(login(signed), [])
  assert.match(out.stdout, /Already signed in/)
  const later = world()
  assert.match(later.run({ KRIYA_URL: "https://kriya.example", KRIYA_NO_LOGIN: "1" }).stdout, /Sign in when you're ready/)
  assert.deepEqual(login(later), [])
})

test("IN-05: KRIYA_NO_MODIFY_PATH leaves the shell's startup files alone", () => {
  const w = world()
  const r = w.run({ KRIYA_NO_MODIFY_PATH: "1" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(join(w.home, ".zshrc")), false)
  assert.match(r.stdout, /Add Kriya Harness to your PATH/)
})

test("IN-06: the script installs this release, on a Node the package accepts, and parses as POSIX sh", () => {
  assert.equal(/^KRIYA_VERSION="(.+)"$/m.exec(SCRIPT)[1], PKG.version)
  const [major, minor] = NODE.split(".").map(Number)
  const [needMajor, needMinor] = /(\d+)\.(\d+)/.exec(PKG.engines.node).slice(1).map(Number)
  assert.ok(major > needMajor || (major === needMajor && minor >= needMinor), `${NODE} vs ${PKG.engines.node}`)
  assert.equal(SCRIPT.match(/echo "[0-9a-f]{64}"/g).length, 4)
  assert.match(SCRIPT.trimEnd(), /\nmain "\$@"$/, "nothing runs until the whole script has arrived")
  assert.equal(spawnSync("/bin/sh", ["-n", join(ROOT, "install.sh")]).status, 0)
})
