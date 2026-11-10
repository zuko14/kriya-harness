import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"

// A change asked for after a cut is made, through a real Host and real FFmpeg: the plan it
// was made from is revised, the story isn't chosen again, and the person's own edit is kept.

test("ET-REV-M1: a change after a make revises that cut: same story, the person's edit kept, and \"start over\" still starts over", { timeout: 500_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-rev-")))
  const folder = join(home, "work", "p")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  rawTake(source)
  fakeRuntime(home)
  const index = indexOf()
  const word = index.words.find((w) => w.id === index.sentences[0].firstWord)
  const tasks = []
  const planRequests = []
  const settings = { seconds: 45, captions: "none", music: "none", cutSound: "none" }
  const plans = [
    { say: "A plain cut.", steps: ["Cut the fillers"], settings },
    { say: "The same cut, with a new look.", steps: ["Change the colour"], settings: { ...settings, grade: "warm" } },
    { say: "A new cut.", steps: ["Begin again"], settings },
  ]
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push(task)
      if (task === "plan") {
        planRequests.push(JSON.stringify(body.messages))
        return { content: JSON.stringify(plans[planRequests.length - 1]) }
      }
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
      if (task === "console") return { content: JSON.stringify({ ops: [{ op: "remove_range", asset: "a1", from: { word: word.id, edge: "start" }, to: { word: word.id, edge: "end" } }], say: "Cut that word." }) }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const until = async (id) => {
    for (;;) {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === id)
      if (["done", "failed"].includes(row.status)) return row
      await new Promise((done) => setTimeout(done, 300))
    }
  }
  const make = async (id, asset, plan) => {
    const done = await until((await call("POST", `/projects/${id}/make`, { asset, brief: plan.brief, plan: { say: plan.say, steps: plan.steps, settings: plan.settings } })).id)
    assert.equal(done.status, "done", done.error)
    return JSON.parse(done.output)
  }
  const stories = () => tasks.filter((t) => t === "story").length
  const picture = async (id) => (await call("GET", `/projects/${id}/plan`)).timeline.picture.filter((p) => !p.hold).map((p) => [p.in, p.out])
  const plays = (cut) => cut.some(([from, to]) => word.start >= from && word.end <= to)
  try {
    const { id } = await call("POST", "/projects", { name: "Talk", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    await until((await call("POST", `/projects/${id}/index`, { asset: asset.id })).id)

    // The first plan is a plan, not a change; its make asks for the story once
    const first = await call("POST", `/projects/${id}/plan`, { text: "Edit this", history: [], choices: {} })
    assert.equal(first.revises, undefined)
    assert.doesNotMatch(planRequests[0], /Your previous plan/)
    const one = await make(id, asset.id, first)
    assert.equal(stories(), 1)
    assert.equal(one.slots.story, "model")
    assert.ok(plays(await picture(id)), "the word plays in the first cut")

    // The person cuts a word by asking, and accepts
    const asked = await call("POST", `/projects/${id}/ask`, { text: "cut the first word", history: [] })
    await call("POST", `/projects/${id}/proposals/${asked.proposal.id}`, { accept: true })
    const edited = await picture(id)
    assert.ok(!plays(edited), "the word is out of the cut")

    // A change to the whole video: the Host revises the plan it made, with nothing sent back by the browser
    const second = await call("POST", `/projects/${id}/plan`, { text: "make the whole video warmer", history: [], choices: {} })
    assert.equal(second.revises, true)
    assert.deepEqual(second.differs, ["Colour look: none → warm"])
    assert.equal(second.keepsStory, true)
    assert.match(planRequests[1], /Your previous plan/)
    const two = await make(id, asset.id, second)
    console.log(`ET-REV-M1: ${two.verdict}\n${two.notes.join("\n")}`)
    assert.equal(stories(), 1, "the story wasn't chosen again")
    assert.equal(two.slots.story, "kept")
    assert.ok(two.notes.some((n) => /^Kept 1 of your own edit to the last cut/.test(n)), two.notes.join("; "))
    assert.deepEqual(await picture(id), edited, "the same cut, with the person's edit still in it")

    // "Start over" is the one way out: a new story, and the old edits aren't carried
    const again = await call("POST", `/projects/${id}/plan`, { text: "start over from scratch", history: [], choices: {} })
    assert.equal(again.revises, undefined)
    assert.equal(again.brief.fresh, true)
    const three = await make(id, asset.id, again)
    assert.equal(stories(), 2, "starting over chooses the story again")
    assert.ok(!three.notes.some((n) => /your own edit/.test(n)), three.notes.join("; "))
    assert.ok(plays(await picture(id)), "the word plays again")
  } finally {
    await stopHost(home)
    await fake.close?.()
  }
})
