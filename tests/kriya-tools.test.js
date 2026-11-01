import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"

import { kriyaSkills, memorySave, memorySearch } from "../plugins/kriya-tools/index.js"
import { BASE_PATH } from "../src/api.js"
import { startFakeKriya } from "./fake-kriya.js"
import { route, violations } from "./helpers.js"

// H7 client part (HD-10): Kriya's skills as a DeepSeek Harness skill source
// (ranked below the person's own local skills) and the two memory tools,
// against the fake Kriya. The real DSH composing them is
// tests/kriya-tools-run.test.js.

const SKILLS = [
  {
    id: "task-planning",
    name: "Task planning",
    version: "1.0.0",
    description: "Break a request into steps before acting.",
    activation: { always: false, keywords: ["plan", "steps"] },
  },
  {
    id: "my-abcdefghij",
    name: "Dinner planner",
    version: "2.0.0",
    description: "Plans dinners around allergies.",
    activation: { always: false, keywords: ["dinner"] },
  },
]

let fake
before(async () => {
  fake = await startFakeKriya()
})
after(() => fake.close())

beforeEach(() => {
  process.env.KRIYA_DEVICE_TOKEN = fake.issueToken()
  process.env.KRIYA_GATEWAY_URL = `${fake.url}${BASE_PATH}`
  fake.state.skills = structuredClone(SKILLS)
  fake.state.skillBodies = new Map([
    ["task-planning", "# Task planning\n\nList the steps first."],
    ["my-abcdefghij", "Ask about allergies first."],
  ])
  fake.state.notes = []
  fake.state.saved = []
  fake.state.skillsDown = false
  fake.state.requests.length = 0
})

const requests = (path) => fake.state.requests.filter((r) => r.path === path)
const exec = { signal: new AbortController().signal }

test("the skill source lists the device agent's skills, below the person's own", async () => {
  const provider = kriyaSkills()
  assert.equal(provider.name, "kriya")
  const candidates = await provider.list({})
  assert.deepEqual(
    candidates.map((c) => [c.name, c.provider, c.source, c.rank > 0, c.invocation.modelInvocable]),
    [
      ["task-planning", "kriya", "custom", true, true],
      ["my-abcdefghij", "kriya", "custom", true, true],
    ]
  )
  assert.match(candidates[0].whenToUse, /plan, steps/)
  assert.deepEqual(violations(route("GET", "/skills").response, requests("/skills")[0].response), [])
})

test("a body is fetched once per version, as markdown", async () => {
  const provider = kriyaSkills()
  const [planning] = await provider.list({})
  const first = await provider.get(planning, {})
  assert.equal(first.content, "# Task planning\n\nList the steps first.")
  assert.equal(first.name, "task-planning")
  await provider.get(planning, {})
  assert.equal(requests("/skills/task-planning/1.0.0").length, 1)
})

test("the list is kept a minute, then rechecked with its ETag (304 keeps it)", async () => {
  let now = 1_000_000
  const provider = kriyaSkills({ now: () => now })
  await provider.list({})
  await provider.list({})
  assert.equal(requests("/skills").length, 1)
  now += 61_000
  assert.equal((await provider.list({})).length, 2)
  const [, recheck] = requests("/skills")
  assert.ok(recheck.headers["if-none-match"])
  assert.equal(recheck.status, 304)
  fake.state.skills.pop()
  now += 61_000
  assert.equal((await provider.list({})).length, 1)
})

test("signed out: no Kriya skills; Kriya down: the last list stays, marked incomplete", async () => {
  delete process.env.KRIYA_DEVICE_TOKEN
  assert.deepEqual(await kriyaSkills().list({}), [])
  assert.equal(fake.state.requests.length, 0)

  process.env.KRIYA_DEVICE_TOKEN = fake.issueToken()
  let now = 0
  const provider = kriyaSkills({ now: () => now })
  await provider.list({})
  fake.state.skillsDown = true
  now += 61_000
  const kept = await provider.list({})
  assert.equal(kept.complete, false)
  assert.equal(kept.candidates.length, 2)
  const cold = await kriyaSkills().list({})
  assert.deepEqual(cold, { candidates: [], complete: false })
})

test("kriya_memory_search returns the agent's notes, unconfirmed ones marked", async () => {
  fake.state.notes = [
    { id: "n1", content: "The project uses pnpm", kind: "fact", confirmed: true, shared: false },
    { id: "n2", content: "pnpm caches in the home folder", kind: "fact", confirmed: false, shared: true },
  ]
  const result = await memorySearch.execute({ query: "pnpm", limit: 5 }, exec)
  assert.deepEqual(result.notes.map((n) => n.id), ["n1", "n2"])
  const [sent] = requests("/memory/search")
  assert.deepEqual(sent.body, { query: "pnpm", limit: 5 })
  assert.deepEqual(violations(route("POST", "/memory/search").request, sent.body), [])
  const text = memorySearch.output.render({}, result)[0].text
  assert.match(text, /The project uses pnpm/)
  assert.match(text, /unconfirmed.*pnpm caches/)
})

test("kriya_memory_save saves an unconfirmed note; Kriya's refusals reach the model as errors", async () => {
  const saved = await memorySave.execute({ content: "Use pnpm, not npm." }, exec)
  assert.deepEqual(saved, { id: "note-1", confirmed: false })
  assert.deepEqual(fake.state.saved, [{ id: "note-1", content: "Use pnpm, not npm." }])
  assert.match(memorySave.output.render({}, saved)[0].text, /until the person confirms it in Kriya/)
  await assert.rejects(memorySave.execute({ content: "card 4111 1111 1111 1111" }, exec), /Not saved/)
  delete process.env.KRIYA_DEVICE_TOKEN
  await assert.rejects(memorySearch.execute({ query: "x" }, exec), /kriya login/)
})
