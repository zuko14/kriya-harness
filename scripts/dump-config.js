import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Records `dsh --profile <name> --dump-config` of each Kriya profile in
// expected/<name>.dump.yml (H4 exit: a recorded dump). A throwaway Kriya
// home keeps the person's own profile patches out of the record.
// tests/profiles.test.js compares a fresh dump with these files.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
process.env.KRIYA_HOME = mkdtempSync(join(tmpdir(), "kriya-dump-"))

const { dumpConfig } = await import("../src/launch.js")
const { PROFILES } = await import("../src/profiles.js")

for (const profile of Object.keys(PROFILES)) {
  writeFileSync(join(ROOT, "expected", `${profile}.dump.yml`), dumpConfig(profile))
  console.log(`dump-config: expected/${profile}.dump.yml`)
}
