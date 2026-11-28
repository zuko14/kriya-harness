import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { SWITCHES, switchEnv } from "../src/modes.js"
import { shareStatus } from "../src/outcomes.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W12 (release): every workforce part ships off. WT-REG-04.

test("WT-REG-04: every Harness 2.0 switch and sharing default off; switched off, nothing reads their files", () => {
  const wanted = { cartridges: "KRIYA_CARTRIDGES", orchestra: "KRIYA_ORCHESTRA", gates: "KRIYA_GATES", critic: "KRIYA_CRITIC", milestones: "KRIYA_MILESTONES", grounding: "KRIYA_GROUNDING", "repo-tools": "KRIYA_REPO_TOOLS", mcp: "KRIYA_MCP", deploy: "KRIYA_DEPLOY" }
  for (const [flag, name] of Object.entries(wanted)) assert.deepEqual(SWITCHES.find(([f]) => f === flag), [flag, name, false], flag)
  const env = {}
  // No saved switches: the person's own ~/.kriya/switches.json mustn't reach this test
  switchEnv([], env, {})
  for (const name of Object.values(wanted)) assert.equal(env[name], "off", name)
  freshHome()
  assert.deepEqual(shareStatus(), { on: false })
  // The contract copy is the one SOURCE.md records (tests/contract.test.js checks the hash)
  assert.match(readFileSync(join(ROOT, "contract", "SOURCE.md"), "utf8"), /Harness 2\.0 W11/)
  assert.match(readFileSync(join(ROOT, "SAFETY.md"), "utf8"), /everything off by default/)
})
