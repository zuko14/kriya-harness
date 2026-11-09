import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { deviceCode, deviceToken } from "../src/api.js"
import { runDaemon } from "../src/daemon.js"
import { checkRuntime, hardwareTier } from "../src/edit/runtime/doctor.js"
import { fetchManifest } from "../src/edit/runtime/fetch.js"
import { openManifest, RuntimeError, TRUSTED_KEYS } from "../src/edit/runtime/manifest.js"
import { activeRuntime, install, rollback } from "../src/edit/runtime/setup.js"
import { SWITCHES, switchEnv } from "../src/modes.js"
import { readDevice, writeDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The Media Runtime (ED2): installed from a signed fixture manifest served on
// this machine. No test here reaches the internet, a real runtime or ~/.kriya.

const PLATFORM = "darwin-arm64"
const keys = generateKeyPairSync("ed25519")
const PUBLIC = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")
const sha256 = (data) => createHash("sha256").update(data).digest("hex")

/** Serves files with Range support; `cutAfter` drops the connection part way, once. */
async function fileServer(files) {
  const state = { requests: [], cutAfter: null }
  const server = createServer((req, res) => {
    const data = files[req.url]
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "")
    state.requests.push({ url: req.url, range: range ? Number(range[1]) : null, auth: req.headers.authorization })
    if (!data) return res.writeHead(404).end()
    const from = range ? Number(range[1]) : 0
    const body = data.subarray(from)
    res.writeHead(range ? 206 : 200, { "content-length": body.length })
    if (state.cutAfter !== null) {
      const cut = state.cutAfter
      state.cutAfter = null
      res.write(body.subarray(0, cut), () => res.destroy())
      return
    }
    res.end(body)
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address()
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) }
}

function fixtureManifest(url, { version = "2026.11.0", data = Buffer.alloc(200_000, 7), over = {} } = {}) {
  return {
    schema: 1,
    version,
    platforms: {
      [PLATFORM]: {
        system: [
          { id: "ffmpeg", tools: ["ffmpeg", "ffprobe"], minVersion: "6.0", fix: "brew install ffmpeg" },
          { id: "uv", tools: ["uv"], minVersion: "0.13.0", fix: "brew install uv" },
        ],
        artifacts: [{ id: "tool", tier: "core", version: "1.0.0", url: `${url}/tool.bin`, sha256: sha256(data), bytes: data.length, unpack: "none", entry: "tool.bin", licence: "MIT", ...over }],
        python: { id: "speech", tier: "core", version: "3.12", check: "mlx_whisper", estimateBytes: 1000, requirements: "mlx-whisper==0.4.3 \\\n    --hash=sha256:aa\n", packages: [{ name: "mlx-whisper", version: "0.4.3", licence: "MIT" }] },
      },
    },
  }
}

function signed(manifest) {
  const text = JSON.stringify(manifest)
  return { manifest: text, signature: sign(null, Buffer.from(text), keys.privateKey).toString("base64") }
}

// uv as a recording script: makes the interpreter the check runs
function fakeRun(log = []) {
  return async (command, args) => {
    log.push([command, ...args])
    if (command === "uv" && args[0] === "--version") return "uv 0.13.1"
    if (command === "uv" && args[0] === "venv") {
      const dir = args.at(-1)
      mkdirSync(join(dir, "bin"), { recursive: true })
      writeFileSync(join(dir, "bin", "python"), "")
      mkdirSync(join(dir, "..", "..", ".downloads", "uv"), { recursive: true })
    }
    return ""
  }
}

const options = (home, over = {}) => ({ home, platform: PLATFORM, run: fakeRun(), free: () => 1e12, say: () => {}, ...over })
const open = (manifest) => openManifest(signed(manifest), [PUBLIC])

test("ET-RT-01: installs from a fixture manifest, and marks it complete last", async () => {
  const home = freshHome()
  const data = Buffer.alloc(50_000, 3)
  const files = await fileServer({ "/tool.bin": data })
  try {
    const log = []
    const result = await install(open(fixtureManifest(files.url, { data })), options(home, { run: fakeRun(log) }))
    assert.equal(result.version, "2026.11.0")
    const dir = join(home, "media", "2026.11.0")
    assert.deepEqual(readFileSync(join(dir, "tool", "tool.bin")), data)
    assert.equal(activeRuntime(home).version, "2026.11.0")
    assert.equal(files.state.requests[0].auth, undefined, "the device token never goes to an artifact host")

    const pip = log.find(([, sub]) => sub === "pip")
    for (const flag of ["--require-hashes", "--only-binary"]) assert.ok(pip.includes(flag), flag)
    assert.ok(log.some(([command, ...rest]) => command.endsWith("python") && rest.join(" ").includes("import mlx_whisper")))

    // A second run does no work
    const before = files.state.requests.length
    await install(open(fixtureManifest(files.url, { data })), options(home))
    assert.equal(files.state.requests.length, before)
    assert.deepEqual(readdirSync(join(home, "media", ".downloads")), [], "downloads and uv's cache don't linger")
  } finally {
    await files.close()
  }
})

test("ET-RT-01: a cut connection resumes where it stopped", async () => {
  const home = freshHome()
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251))
  const files = await fileServer({ "/tool.bin": data })
  try {
    files.state.cutAfter = 120_000
    const opened = open(fixtureManifest(files.url, { data }))
    await assert.rejects(install(opened, options(home)), (error) => {
      assert.ok(error instanceof RuntimeError)
      assert.match(error.message, /run kriya edit setup again/i)
      return true
    })
    assert.equal(activeRuntime(home), null, "half an install is never active")

    await install(opened, options(home))
    const resumed = files.state.requests.at(-1)
    assert.ok(resumed.range > 0, "asked only for the rest")
    assert.deepEqual(readFileSync(join(home, "media", "2026.11.0", "tool", "tool.bin")), data)
  } finally {
    await files.close()
  }
})

test("ET-RT-01: a server that ignores Range starts the file over, and the hash still holds", async () => {
  const home = freshHome()
  const data = Buffer.alloc(40_000, 9)
  const plain = createServer((_, res) => res.end(data))
  await new Promise((done) => plain.listen(0, "127.0.0.1", done))
  try {
    const url = `http://127.0.0.1:${plain.address().port}`
    const manifest = fixtureManifest(url, { data })
    mkdirSync(join(home, "media", ".downloads"), { recursive: true })
    writeFileSync(join(home, "media", ".downloads", `${sha256(data)}.part`), Buffer.alloc(10_000, 9))
    await install(open(manifest), options(home))
    assert.deepEqual(readFileSync(join(home, "media", "2026.11.0", "tool", "tool.bin")), data)
  } finally {
    await new Promise((done) => plain.close(done))
  }
})

test("ET-RT-01: a zip artifact unpacks into the runtime", async () => {
  const home = freshHome()
  const dir = mkdtempSync(join(tmpdir(), "kriya-zip-"))
  writeFileSync(join(dir, "hello.txt"), "hello")
  execFileSync("zip", ["-q", "fixture.zip", "hello.txt"], { cwd: dir })
  const data = readFileSync(join(dir, "fixture.zip"))
  const files = await fileServer({ "/tool.bin": data })
  try {
    await install(open(fixtureManifest(files.url, { data, over: { unpack: "zip", entry: "hello.txt" } })), options(home))
    assert.equal(readFileSync(join(home, "media", "2026.11.0", "tool", "hello.txt"), "utf8"), "hello")
  } finally {
    await files.close()
  }
})

test("ET-RT-02: a wrong hash is refused and deleted, and the runtime stays as it was", async () => {
  const home = freshHome()
  const good = Buffer.alloc(30_000, 1)
  const tampered = Buffer.alloc(30_000, 2)
  const files = await fileServer({ "/tool.bin": tampered })
  try {
    await assert.rejects(install(open(fixtureManifest(files.url, { data: good })), options(home)), /hash/i)
    assert.deepEqual(readdirSync(join(home, "media", ".downloads")), [], "the bad bytes are gone")
    assert.equal(existsSync(join(home, "media", "2026.11.0")), false)
    assert.equal(activeRuntime(home), null)
  } finally {
    await files.close()
  }
})

test("ET-RT-02: more bytes than the manifest says stops the download", async () => {
  const home = freshHome()
  const files = await fileServer({ "/tool.bin": Buffer.alloc(50_000, 4) })
  try {
    const manifest = fixtureManifest(files.url, { data: Buffer.alloc(1_000, 4) })
    await assert.rejects(install(open(manifest), options(home)), /larger than/i)
    assert.deepEqual(readdirSync(join(home, "media", ".downloads")), [])
  } finally {
    await files.close()
  }
})

test("ET-RT-02: an unsigned, forged or altered manifest is refused before anything is read", () => {
  const manifest = fixtureManifest("https://example.test")
  const good = signed(manifest)
  assert.throws(() => openManifest({ ...good, signature: null }, [PUBLIC]), /isn't signed/)
  assert.throws(() => openManifest({ ...good, manifest: `${good.manifest} ` }, [PUBLIC]), /isn't signed/)
  const other = generateKeyPairSync("ed25519")
  assert.throws(() => openManifest({ ...good, signature: sign(null, Buffer.from(good.manifest), other.privateKey).toString("base64") }, [PUBLIC]), /isn't signed/)
  assert.throws(() => openManifest(good, []), /isn't signed/, "no trusted key, no install")
  assert.deepEqual(TRUSTED_KEYS, ["MCowBQYDK2VwAyEAOS8m+4bFVNmiA4Q/iM3osrmj/O2uShAD7lROZezQ6Rk="])
})

test("ET-RT-02: a signed manifest still can't name a path, a plain-http host or a loose hash", () => {
  const bad = (change) => {
    const manifest = fixtureManifest("https://example.test")
    change(manifest, manifest.platforms[PLATFORM])
    assert.throws(() => open(manifest), /manifest/i)
  }
  bad((m) => (m.version = "../../evil"))
  bad((m) => (m.schema = 2))
  bad((_, p) => (p.artifacts[0].id = "../up"))
  bad((_, p) => (p.artifacts[0].url = "http://example.test/tool"))
  bad((_, p) => (p.artifacts[0].sha256 = "abc"))
  bad((_, p) => (p.artifacts[0].entry = "../../bin/sh"))
  bad((_, p) => (p.artifacts[0].unpack = "script"))
  bad((_, p) => (p.python.check = "os; import sys"))
  bad((_, p) => (p.python.version = "latest"))
})

test("a computer with no runtime, too little disk or no uv gets a plain reason", async () => {
  const home = freshHome()
  const opened = open(fixtureManifest("http://127.0.0.1:9"))
  await assert.rejects(install(opened, options(home, { platform: "win32-x64" })), /isn't available for this computer/)
  await assert.rejects(install(opened, options(home, { free: () => 10 })), /free/)
  const noUv = async (command) => {
    if (command === "uv") throw Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" })
    return ""
  }
  await assert.rejects(install(opened, options(home, { run: noUv })), /brew install uv/)
})

test("ET-RT-04: two versions side by side; a new one leaves the old; rollback works", async () => {
  const home = freshHome()
  const one = Buffer.alloc(10_000, 1)
  const two = Buffer.alloc(10_000, 2)
  const files = await fileServer({ "/one.bin": one, "/two.bin": two })
  try {
    const first = fixtureManifest(files.url, { version: "2026.11.0", data: one, over: { url: `${files.url}/one.bin` } })
    const second = fixtureManifest(files.url, { version: "2026.12.0", data: two, over: { url: `${files.url}/two.bin` } })
    await install(open(first), options(home))
    await install(open(second), options(home))
    assert.equal(activeRuntime(home).version, "2026.12.0")
    assert.ok(existsSync(join(home, "media", "2026.11.0", ".complete")))
    assert.ok(existsSync(join(home, "media", "2026.12.0", ".complete")))

    assert.equal(rollback(home).version, "2026.11.0")
    assert.equal(activeRuntime(home).version, "2026.11.0")
    assert.equal(rollback(home).version, "2026.12.0", "and back")

    // A failed update leaves the working version active
    const broken = fixtureManifest(files.url, { version: "2027.1.0", data: Buffer.alloc(5, 9), over: { url: `${files.url}/nope.bin` } })
    await assert.rejects(install(open(broken), options(home)))
    assert.equal(activeRuntime(home).version, "2026.12.0")
  } finally {
    await files.close()
  }
  assert.throws(() => rollback(freshHome()), /nothing to roll back/i)
})

const ENCODERS = `Encoders:
 V..... libx264              libx264 H.264 / AVC
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder`

function machine(over = {}) {
  const answers = {
    "ffmpeg -version": "ffmpeg version 8.0.1 Copyright (c) 2000-2026\nconfiguration: --enable-gpl",
    "ffprobe -version": "ffprobe version 8.0.1 Copyright (c) 2007-2026",
    "ffmpeg -hide_banner -encoders": ENCODERS,
    "uv --version": "uv 0.13.1 (Homebrew)",
    "system_profiler SPDisplaysDataType": "Graphics/Displays:\n  Apple M5:\n    Metal Support: Metal 4",
    ...over,
  }
  return async (command, args) => {
    const key = [command, ...args].join(" ")
    const answer = answers[key]
    if (answer === undefined) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })
    return answer
  }
}

const probe = (over = {}) => {
  const lines = []
  return { lines, run: checkRuntime({ home: freshHome(), platform: PLATFORM, run: machine(), free: () => 300e9, memory: 16 * 2 ** 30, cpu: "Apple M5", cwd: tmpdir(), say: (line) => lines.push(line), ...over }) }
}

test("ET-RT-03: on a capable Mac with no runtime: what's there, what's missing, and the tier", async () => {
  const { lines, run } = probe()
  const report = await run
  assert.equal(report.ok, false, "no runtime yet")
  assert.equal(report.ffmpeg, "8.0.1")
  assert.deepEqual(report.encoders, ["h264_videotoolbox", "hevc_videotoolbox"])
  assert.equal(report.metal, true)
  assert.equal(report.tier, "standard")
  assert.equal(report.runtime, null)
  const text = lines.join("\n")
  assert.match(text, /ok {4}FFmpeg 8\.0\.1/)
  assert.match(text, /ok {4}hardware encoders: h264_videotoolbox, hevc_videotoolbox/)
  assert.match(text, /ok {4}Metal/)
  assert.match(text, /ok {4}disk: 300 GB free/)
  assert.match(text, /FAIL {2}Media Runtime — run kriya edit setup/)
})

test("ET-RT-03: a missing or mismatched FFmpeg names its fix; EH-51's mismatched pair fails", async () => {
  const missing = probe({ run: machine({ "ffmpeg -version": undefined, "ffprobe -version": undefined, "ffmpeg -hide_banner -encoders": undefined }) })
  const none = await missing.run
  assert.equal(none.ffmpeg, null)
  assert.deepEqual(none.encoders, [])
  assert.match(missing.lines.join("\n"), /FAIL {2}FFmpeg — brew install ffmpeg/)

  const pair = probe({ run: machine({ "ffprobe -version": "ffprobe version 4.4.1 Copyright" }) })
  await pair.run
  assert.match(pair.lines.join("\n"), /FAIL {2}.*ffprobe 4\.4\.1 doesn't match FFmpeg 8\.0\.1/)

  const old = probe({ run: machine({ "ffmpeg -version": "ffmpeg version 5.1 Copyright", "ffprobe -version": "ffprobe version 5.1 Copyright" }) })
  await old.run
  assert.match(old.lines.join("\n"), /FAIL {2}FFmpeg 5\.1 is older than 6\.0/)

  const git = probe({ run: machine({ "ffmpeg -version": "ffmpeg version N-115000-gabc123 Copyright", "ffprobe -version": "ffprobe version N-115000-gabc123 Copyright" }) })
  assert.equal((await git.run).ffmpeg, "N-115000-gabc123", "a development build is reported, not refused")
})

test("ET-RT-03: a build with no drawtext is named, and doesn't fail the check", async () => {
  const plain = probe({ run: machine({ "ffmpeg -hide_banner -filters": " T.. trim V->V x" }) })
  await plain.run
  assert.match(plain.lines.join("\n"), /note {2}this FFmpeg has no drawtext/)
  const full = probe({ run: machine({ "ffmpeg -hide_banner -filters": " T.. drawtext V->V x" }) })
  await full.run
  assert.doesNotMatch(full.lines.join("\n"), /drawtext/)
})

test("ET-RT-03: tiers, a full disk and no hardware encoder", async () => {
  assert.equal(hardwareTier({ memory: 16 * 2 ** 30, metal: true }), "standard")
  assert.equal(hardwareTier({ memory: 8 * 2 ** 30, metal: true }), "core")
  assert.equal(hardwareTier({ memory: 32 * 2 ** 30, metal: false }), "core")

  const small = probe({ free: () => 2e9 })
  await small.run
  assert.match(small.lines.join("\n"), /FAIL {2}disk: 2 GB free/)

  const soft = probe({ run: machine({ "ffmpeg -hide_banner -encoders": "Encoders:\n V..... libx264 libx264" }) })
  await soft.run
  assert.match(soft.lines.join("\n"), /note {2}no hardware encoder/)
})

test("ET-RT-03: with a working runtime every check passes, and a broken sidecar is named", async () => {
  const home = freshHome()
  const data = Buffer.alloc(1_000, 6)
  const files = await fileServer({ "/tool.bin": data })
  try {
    await install(open(fixtureManifest(files.url, { data })), options(home))
  } finally {
    await files.close()
  }
  chmodSync(join(home, "media", "2026.11.0", "tool", "tool.bin"), 0o755)
  const python = join(home, "media", "2026.11.0", "python", "bin", "python")
  const answers = { [`${python} -c import mlx_whisper`]: "" }
  const healthy = probe({ home, run: machine(answers) })
  const report = await healthy.run
  assert.equal(report.ok, true, healthy.lines.join("\n"))
  assert.equal(report.runtime, "2026.11.0")
  assert.match(healthy.lines.join("\n"), /ok {4}Media Runtime 2026\.11\.0/)
  assert.match(healthy.lines.join("\n"), /ok {4}speech: mlx_whisper/)
  assert.match(healthy.lines.join("\n"), /ok {4}tool 1\.0\.0/)

  const broken = probe({ home })
  assert.equal((await broken.run).ok, false)
  assert.match(broken.lines.join("\n"), /FAIL {2}speech: mlx_whisper — run kriya edit setup/)
})

function kriya(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { env: { ...process.env, ...env } })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("exit", (code) => done({ code, stdout }))
  })
}

test("ET-REG-01: off is the default, and off runs nothing", async () => {
  assert.deepEqual(SWITCHES.find(([name]) => name === "edit"), ["edit", "KRIYA_EDIT", false])
  const env = {}
  switchEnv([], env)
  assert.equal(env.KRIYA_EDIT, "off")
  const args = ["--edit"]
  switchEnv(args, env)
  assert.equal(env.KRIYA_EDIT, "on")
  assert.deepEqual(args, [])

  const home = freshHome()
  for (const setting of [{}, { KRIYA_EDIT: "off" }, { KRIYA_EDIT: "false" }]) {
    const off = await kriya(["edit", "doctor"], { ...setting, KRIYA_EDIT: setting.KRIYA_EDIT ?? "", KRIYA_HOME: home })
    assert.equal(off.code, 1)
    assert.match(off.stdout, /Editing is off/)
    assert.doesNotMatch(off.stdout, /FFmpeg/)
  }
  assert.equal(existsSync(join(home, "media")), false)

  const source = readFileSync(join(ROOT, "bin", "kriya.js"), "utf8")
  assert.doesNotMatch(source, /^import .*src\/edit/m, "nothing under src/edit loads unless the switch is on")
  assert.match(source, /await import\("\.\.\/src\/edit\/runtime\/cli\.js"\)/)
  const help = await kriya(["--help"], { KRIYA_HOME: home })
  assert.doesNotMatch(help.stdout, /kriya edit|--edit/, "no new help text with the switch off")
})

test("ET-REG-01: `kriya --edit` is a known flag, and `edit` with an unknown word says what it takes", async () => {
  const home = freshHome()
  const flag = await kriya(["--edit"], { KRIYA_HOME: home })
  assert.doesNotMatch(flag.stdout, /Unknown/)
  const word = await kriya(["edit", "fly"], { KRIYA_HOME: home, KRIYA_EDIT: "on" })
  assert.equal(word.code, 1)
  assert.match(word.stdout, /kriya edit setup/)
  assert.match(word.stdout, /kriya edit doctor/)
})

test("ET-REG-03: against a server with no editing the client says so, and hello sends no new field", async () => {
  const home = freshHome()
  const fake = await startFakeKriya({ approveAfter: 0 })
  try {
    const code = await deviceCode(fake.url, { deviceName: "Test laptop", platform: "darwin" })
    const { token, deviceId } = await deviceToken(fake.url, code.deviceCode)
    writeDevice({ url: fake.url, token, deviceId })
    const device = readDevice()

    await assert.rejects(fetchManifest(device), (error) => {
      assert.ok(error instanceof RuntimeError)
      assert.match(error.message, /isn't available on your Kriya yet/)
      return true
    })
    const setup = await kriya(["edit", "setup"], { KRIYA_HOME: home, KRIYA_EDIT: "on" })
    assert.equal(setup.code, 1)
    assert.match(setup.stdout, /isn't available on your Kriya yet/)

    const folder = mkdtempSync(join(tmpdir(), "kriya-reg-"))
    await runDaemon({ device, folders: [folder], once: true, log: () => {} })
    assert.deepEqual(Object.keys(fake.state.hello.capabilities).sort(), ["fullAccess", "handoff", "serve"])
  } finally {
    await fake.close()
  }
})

test("ES-23: children get a built environment, never the device token", async () => {
  const { childEnv } = await import("../src/edit/runtime/setup.js")
  const env = childEnv("/tmp/home", { PATH: "/bin", HOME: "/h", KRIYA_DEVICE_TOKEN: "secret", KRIYA_TOKEN: "secret", OPENROUTER_API_KEY: "secret" })
  assert.equal(JSON.stringify(env).includes("secret"), false)
  assert.equal(env.PATH, "/bin")
  assert.ok(env.UV_CACHE_DIR.startsWith("/tmp/home"), "the runtime's files stay in the runtime's folder")
})
