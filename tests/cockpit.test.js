import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { CockpitError, connection, githubSignIn, health, ignoreSecrets, parseListeners, PROVIDERS, runner, servers, stopServer, versionOf } from "../src/cockpit.js"
import { saveSwitch, savedSwitches, switchEnv } from "../src/modes.js"
import { handler } from "../plugins/cockpit/index.js"
import { FOREIGN, pick, providerTools } from "../plugins/providers/index.js"

// The Developer tab (plugins/cockpit, src/cockpit.js) and the Supabase and
// Render tools (plugins/providers); Kriya-Tavi docs/kriya-harness/DEVELOPER_COCKPIT.md.
// No real provider is called: CLIs and process lists are faked; git is real.

const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const ok = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr })
const fail = (stderr = "", code = 1) => ({ code, stdout: "", stderr })

test("CK-01: listening sockets from lsof -F, one row per process with its ports", () => {
  const text = "p101\ncnode\nn*:3000\nn127.0.0.1:3000\nn[::1]:9229\np202\ncpostgres\nn127.0.0.1:5432\np303\ncbroken\n"
  assert.deepEqual(parseListeners(text), [
    { pid: 101, command: "node", ports: [3000, 9229] },
    { pid: 202, command: "postgres", ports: [5432] },
  ])
  assert.equal(versionOf("gh version 2.103.3 (2026-10-26)\nhttps://github.com/cli/cli"), "2.103.3")
})

test("CK-02: only servers whose folder is inside the project; stop only one of those", async () => {
  const project = tmp("kriya-ck-proj-")
  mkdirSync(join(project, "web"))
  const elsewhere = tmp("kriya-ck-else-")
  const cwd = { 11: join(project, "web"), 22: elsewhere, [process.pid]: project }
  const run = async (file, args) => {
    if (args.includes("-iTCP")) return ok(`p11\ncnext\nn*:3000\np22\ncother\nn*:4000\np${process.pid}\nckriya\nn*:3091\n`)
    const pid = args[args.indexOf("-p") + 1]
    return cwd[pid] ? ok(`p${pid}\nfcwd\nn${cwd[pid]}\n`) : ok("")
  }
  const { available, list } = await servers(project, run)
  assert.equal(available, true)
  assert.deepEqual(list, [{ pid: 11, command: "next", ports: [3000], folder: "web" }])
  const killed = []
  await stopServer(project, 11, run, (pid, sig) => killed.push([pid, sig]))
  assert.deepEqual(killed, [[11, "SIGTERM"]])
  await assert.rejects(stopServer(project, 22, run, () => assert.fail("never")), CockpitError)
  assert.deepEqual(await servers(project, async () => ({ missing: true, code: 1 })), { available: false, list: [] })
})

test("CK-03: a provider's connection: not installed, signed in (GitHub's account), signed out", async () => {
  const gh = PROVIDERS.find((p) => p.id === "github")
  const supa = PROVIDERS.find((p) => p.id === "supabase")
  assert.deepEqual(await connection(gh, async () => ({ missing: true, code: 1 })), { id: "github", name: "GitHub", cli: "gh", login: "gh auth login", install: "brew install gh", docs: "https://cli.github.com", installed: false, signedIn: false })
  const signedIn = await connection(gh, async (_f, args) => (args[0] === "--version" ? ok("gh version 2.103.3 (2026-10-26)\n") : ok("", "github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n")))
  assert.equal(signedIn.signedIn, true)
  assert.equal(signedIn.account, "octo-cat")
  assert.equal(signedIn.version, "2.103.3")
  const out = await connection(supa, async (_f, args) => (args[0] === "--version" ? ok("2.121.0\n") : fail("Access token not provided. Supply an access token by running supabase login")))
  assert.deepEqual([out.installed, out.signedIn, out.account], [true, false, undefined])
  // Every status command is a fixed argv, and nothing reads a token
  for (const p of PROVIDERS) assert.ok(!p.status.some((a) => /token/i.test(a)), p.id)
})

test("CK-04: GitHub sign-in shows gh's one-time code, presses Enter for gh, and reports the end", async () => {
  const spawned = []
  const fake = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.written = []
    child.stdin = { write: (t) => child.written.push(t) }
    child.kill = () => child.emit("close", null)
    spawned.push(child)
    return child
  }
  const s = githubSignIn({ spawnImpl: (file, args) => (assert.deepEqual([file, ...args], ["gh", "auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key"]), fake()) })
  assert.deepEqual(s.start(), { status: "starting" })
  spawned[0].stderr.emit("data", "! First copy your one-time code: AB12-CD34\nPress Enter to open https://github.com/login/device in your browser...")
  assert.deepEqual(s.state(), { status: "waiting", code: "AB12-CD34" })
  assert.deepEqual(spawned[0].written, ["\n"])
  s.start()
  assert.equal(spawned.length, 1, "one sign-in at a time")
  spawned[0].emit("close", 0)
  assert.deepEqual(s.state(), { status: "done" })
  const missing = githubSignIn({ spawnImpl: () => {
    const c = fake()
    setImmediate(() => c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })))
    return c
  } })
  missing.start()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(missing.state(), { status: "failed", error: "The GitHub CLI (gh) isn't installed." })
})

test("CK-05: project health reads names only; .gitignore gains only the listed secret files", async () => {
  const dir = tmp("kriya-ck-health-")
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "next dev", test: "vitest" } }))
  writeFileSync(join(dir, "pnpm-lock.yaml"), "")
  writeFileSync(join(dir, ".env"), "SECRET=never-read\n")
  writeFileSync(join(dir, ".env.example"), "SECRET=\n")
  writeFileSync(join(dir, "server.pem"), "-----BEGIN-----\n")
  execFileSync("git", ["add", "server.pem"], { cwd: dir })
  const before = await health(dir)
  assert.deepEqual(before.stack, [{ id: "node", label: "Node.js · pnpm" }])
  assert.deepEqual(before.scripts, ["dev", "test"])
  assert.deepEqual(before.tracked, ["server.pem"])
  assert.deepEqual(before.unignored, [".env"])
  assert.ok(!JSON.stringify(before).includes("never-read"), "no value is read")
  await assert.rejects(ignoreSecrets(dir, ["package.json"]), CockpitError)
  assert.deepEqual(await ignoreSecrets(dir, [".env"]), { added: ["/.env"] })
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^# Secrets \(added by Kriya Harness\)\n\/\.env\n$/)
  assert.deepEqual((await health(dir)).unignored, [])
  const plain = await health(tmp("kriya-ck-nogit-"))
  assert.deepEqual([plain.git, plain.tracked, plain.unignored], [false, [], []])
})

test("CK-06: the routes: switches saved, names validated, home refused, unknown actions refused", async () => {
  const project = tmp("kriya-ck-route-")
  const saved = {}
  const calls = []
  const run = async (file, args, cwd) => {
    calls.push([file, ...args])
    if (file === "git" && args[0] === "--version") return ok("git version 2.45.0")
    if (file === "git" && args[0] === "status") return ok("# branch.head main\n")
    if (file === "git" && args[0] === "remote") return ok("")
    if (file === "git" && args[0] === "ls-files") return ok("")
    if (file === "gh" && args[0] === "repo") return ok("https://github.com/octo/app\n")
    return ok("")
  }
  const routes = handler({ folderOf: async (id) => (id === "s1" ? project : id === "home" ? homedir() : undefined), run, signIn: githubSignIn({ spawnImpl: () => assert.fail("not started") }), switches: { read: () => saved, save: (f, on) => (saved[f] = on) } })
  const post = (body) => routes.act(new Request("http://x/api/kriya.cockpit", { method: "POST", body: JSON.stringify(body) }))
  assert.deepEqual((await post({ session: "s1", action: "switch", flag: "repo-tools", on: true })).switches.repoTools.saved, true)
  await assert.rejects(post({ session: "s1", action: "switch", flag: "edit", on: true }), CockpitError)
  await assert.rejects(post({ session: "s1", action: "github.create", name: "bad name; rm" }), /letters, digits/)
  assert.deepEqual(await post({ session: "s1", action: "github.create", name: "app" }), { done: "github.create", url: "https://github.com/octo/app" })
  assert.deepEqual(calls.find((c) => c[0] === "gh" && c[1] === "repo"), ["gh", "repo", "create", "app", "--private", "--source", ".", "--remote", "origin"])
  await assert.rejects(post({ session: "home", action: "git.init" }), /home folder/)
  await assert.rejects(post({ session: "s1", action: "rm -rf" }), /doesn't know/)
  await assert.rejects(post({ session: "nope", action: "git.init" }), /isn't known/)
  const view = await routes.read(new Request(`http://x/api/kriya.cockpit?session=s1`))
  assert.deepEqual(Object.keys(view).sort(), ["connections", "folder", "github", "health", "mode", "own", "servers", "signIn", "switches"])
})

test("CK-07: saved switches: the Developer tab's choice, under the person's flag or variable", () => {
  const dir = tmp("kriya-ck-sw-")
  const file = join(dir, "switches.json")
  assert.deepEqual(savedSwitches(file), {})
  saveSwitch("repo-tools", true, file)
  assert.throws(() => saveSwitch("edit", true, file))
  assert.deepEqual(savedSwitches(file), { "repo-tools": true })
  const env = {}
  switchEnv([], env, savedSwitches(file))
  assert.equal(env.KRIYA_REPO_TOOLS, "on")
  const flagged = {}
  switchEnv(["--no-repo-tools"], flagged, savedSwitches(file))
  assert.equal(flagged.KRIYA_REPO_TOOLS, "off")
  const shell = { KRIYA_REPO_TOOLS: "off" }
  switchEnv([], shell, savedSwitches(file))
  assert.equal(shell.KRIYA_REPO_TOOLS, "off")
  // The cockpit itself is never a saved switch: it comes from the owner
  assert.deepEqual(savedSwitches((writeFileSync(file, JSON.stringify({ cockpit: true, "provider-tools": false })), file)), { "provider-tools": false })
})

test("PV-01: provider tools: exact argv, data marked untrusted and redacted, the local write approved", async () => {
  const calls = []
  let answer = ok("[]")
  const host = { cwd: async () => "/p", approve: async () => true, readOnly: () => false, run: async (file, args) => (calls.push([file, ...args]), answer) }
  const tools = Object.fromEntries(providerTools(host).map((t) => [t.name, t]))
  const exec = { agent: { id: "a" } }
  answer = ok(JSON.stringify([{ name: "app", id: "abcd", region: "ap-south-1", secret: "x", database: { password: "y" } }]))
  const projects = await tools.supabase_projects.execute({}, exec)
  assert.deepEqual(calls.at(-1), ["supabase", "projects", "list", "-o", "json"])
  assert.ok(projects.text.startsWith(FOREIGN))
  assert.ok(!projects.text.includes('"secret"') && !projects.text.includes("password"))
  answer = ok("ok line\nAKIAABCDEFGHIJKLMNOP leaked\n")
  const logs = await tools.render_logs.execute({ service: "srv-abc123", limit: 9999 }, exec)
  assert.deepEqual(calls.at(-1), ["render", "logs", "-r", "srv-abc123", "--limit", "200", "-o", "text"])
  assert.ok(!logs.text.includes("AKIAABCDEFGHIJKLMNOP"), "secrets redacted")
  await assert.rejects(tools.render_deploys.execute({ service: "srv-x; rm -rf /" }, exec), /srv-/)
  answer = { code: 1, stdout: "", stderr: "Error: Access token not provided" }
  await assert.rejects(tools.supabase_projects.execute({}, exec), /supabase login/)
  answer = { code: 1, missing: true, stdout: "", stderr: "" }
  await assert.rejects(tools.render_services.execute({}, exec), /isn't installed/)
  // The one write: refused read-only, refused unapproved (nothing runs), then exactly --local
  const before = calls.length
  await assert.rejects(Object.fromEntries(providerTools({ ...host, readOnly: () => true }).map((t) => [t.name, t])).supabase_migrate_local.execute({}, exec), /Read only/)
  await assert.rejects(Object.fromEntries(providerTools({ ...host, approve: async () => false }).map((t) => [t.name, t])).supabase_migrate_local.execute({}, exec), /didn't approve/)
  assert.equal(calls.length, before, "nothing ran without approval")
  answer = ok("Applying migration 1\n")
  await tools.supabase_migrate_local.execute({}, exec)
  assert.deepEqual(calls.at(-1), ["supabase", "migration", "up", "--local"])
  // Exactly these: reads, and the one local write; nothing pushes, deploys, restarts, deletes or touches --linked
  assert.deepEqual(providerTools(host).map((t) => t.name), ["supabase_projects", "supabase_migrations", "supabase_migrate_local", "render_services", "render_deploys", "render_logs"])
  assert.deepEqual(pick("not json", ["id"]), null)
})

test("PV-02: the default runner closes stdin and adds no prompt", async () => {
  const r = await runner()("node", ["-e", "process.stdin.on('data',()=>{}).on('end',()=>console.log(process.env.GH_PROMPT_DISABLED, process.env.DO_NOT_TRACK))"])
  assert.equal(r.stdout.trim(), "1 1")
})

test("CK-08: planTiers carries the owner's cockpit advert; nothing without it", async () => {
  const { planTiers } = await import("../src/launch.js")
  const device = { url: "http://127.0.0.1:9", token: "t" }
  const answer = (extra) => async () => ({ data: [{ id: "budget" }], ...extra })
  assert.equal((await planTiers(device, answer({ cockpit: 1 }))).cockpit, true)
  assert.equal("cockpit" in (await planTiers(device, answer({}))), false)
})

test("CK-09: a folder that isn't a git repository reads cleanly (owner report 2026-11-24: the tab said \"Kriya couldn't do that\")", async () => {
  const dir = tmp("kriya-ck-nogit2-")
  writeFileSync(join(dir, "index.html"), "<h1>scene</h1>\n")
  const routes = handler({ folderOf: async () => dir })
  const view = await routes.read(new Request("http://x/api/kriya.cockpit?session=s"))
  assert.deepEqual(view.github, { state: "not a repository" })
  assert.equal(view.health.git, false)
  assert.ok(Array.isArray(view.connections))
})

test("CK-10: one section failing says so in its place; the others still load", async () => {
  const dir = tmp("kriya-ck-iso-")
  const logged = []
  const run = async (file, args) => {
    if (file === "lsof") throw new Error("lsof exploded")
    if (file === "git" && args[0] === "--version") return ok("git version 2.45.0")
    if (file === "git") return fail("fatal: not a git repository", 128)
    return { code: 1, missing: true, stdout: "", stderr: "" }
  }
  const routes = handler({ folderOf: async () => dir, run, log: (e) => logged.push(e.message) })
  const view = await routes.read(new Request("http://x/api/kriya.cockpit?session=s"))
  assert.match(view.servers.error, /running servers/)
  assert.deepEqual(view.github, { state: "not a repository" })
  assert.equal(view.health.error, undefined)
  assert.deepEqual(logged, ["lsof exploded"])
})
