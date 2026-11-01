import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { MUST_BE_DISABLED, rowStates } from "../src/doctor.js"
import { dumpConfig } from "../src/launch.js"
import { ensureProfile, PROFILES } from "../src/profiles.js"
import { freshHome, ROOT } from "./helpers.js"

// HT-REL-03: each profile's composed config (dsh --dump-config) equals the
// recorded expected/<profile>.dump.yml, and the rows that matter are as
// they must be: DeepSeek account, models and telemetry disabled; the only
// model route is Kriya's; the Web UI on loopback. A DSH bump that changes
// any of this fails here until the record is re-made and reviewed
// (npm run dump-config).

const dumps = new Map()
const dumpOf = (profile) => {
  if (!dumps.has(profile)) {
    freshHome()
    dumps.set(profile, dumpConfig(profile))
  }
  return dumps.get(profile)
}

for (const profile of Object.keys(PROFILES)) {
  test(`${profile}: the composed config equals the recorded dump`, () => {
    const recorded = readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8")
    assert.equal(dumpOf(profile), recorded)
  })

  test(`${profile}: DeepSeek account, DeepSeek models and telemetry stay disabled`, () => {
    const rows = rowStates(dumpOf(profile))
    for (const id of MUST_BE_DISABLED) if (rows.has(id)) assert.equal(rows.get(id), true, id)
    for (const id of ["deepseek-account", "llm-deepseek", "otel", "session-telemetry-otel"])
      assert.ok(rows.has(id), `${id} row present (and so disabled, not just missing)`)
  })

  test(`${profile}: the default model is Kriya's balanced tier through the Kriya route`, () => {
    const yaml = dumpOf(profile)
    assert.match(yaml, /- id: agent-default-model\n {2}name: '@deepseek-ai\/dsh-agent-default-model'\n {2}config:\n {4}provider: kriya\n {4}model: balanced\n/)
    assert.match(yaml, /baseURL: !!js process\.env\.KRIYA_GATEWAY_URL/)
    assert.match(yaml, /apiKeyEnv: KRIYA_DEVICE_TOKEN/)
    assert.match(yaml, /X-Kriya-Harness: !!js process\.env\.KRIYA_CLIENT_VERSION/)
    // No other provider route is configured in the Kriya bundle
    const providers = /providers:\n((?: {6}.*\n)+)/.exec(yaml)?.[1] ?? ""
    assert.deepEqual([...providers.matchAll(/^ {6}([\w-]+):$/gm)].map((m) => m[1]), ["kriya"])
  })
}

test("kriya: the Web UI binds to 127.0.0.1 unless a host is passed (kriya passes none)", () => {
  assert.match(dumpOf("kriya"), /host: !!js ctx\.webStartup\.host \?\? '127\.0\.0\.1'/)
})

test("profiles are repaired, not reset: the person's own patch survives", () => {
  freshHome()
  const dir = ensureProfile("kriya-run")
  writeFileSync(join(dir, "cordis.patch.yml"), "# mine\n")
  ensureProfile("kriya-run")
  assert.equal(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), "# mine\n")
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dsh.profile.bundles, PROFILES["kriya-run"])
})
