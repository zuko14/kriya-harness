import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { gateCommands, readBaseline, writeCandidate } from "../gate-commands.js"

// Harness 2.0 W6: the gates that run a command the person confirmed (`kriya
// gates use`): G-DATA, G-EVAL, G-SAN, G-IAC, G-SIM, G-SIM-HEADLESS
// (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md §3). Commands run
// through the same sandboxed runner as the project's check; none is ever
// written by a model. Without a confirmed command: not_checked, never pass.

const tail = (s, n = 1500) => String(s ?? "").slice(-n)
const nc = (id, gate) => ({ id, status: "not_checked", reason: `no command is confirmed for ${id} (kriya gates use ${gate} "<command>")` })
const ran = (r) => r.exitCode === 0 && !r.timedOut

/** A content hash of a file or a folder (paths and bytes, sorted), and its line count; null if missing */
export function outputDigest(root, rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) return null
  const files = []
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n))
    else files.push(p)
  }
  walk(abs)
  const h = createHash("sha256")
  let lines = 0
  for (const f of files.slice(0, 2000)) {
    const bytes = readFileSync(f)
    h.update(relative(abs, f)).update("\0").update(bytes)
    lines += bytes.toString("utf8").split("\n").length - 1
  }
  return { sha: h.digest("hex").slice(0, 16), files: files.length, lines }
}

/** G-DATA: the pipeline twice on its fixture: both succeed, and the output is identical */
export async function dataGate({ root, command }) {
  const cfg = gateCommands(root).data
  if (!cfg) return nc("G-DATA", "data")
  const first = await command(cfg.command)
  if (!ran(first)) return { id: "G-DATA", status: "fail", kind: "gate", excerpt: `G-DATA: the pipeline failed (${first.timedOut ? "timed out" : `exit ${first.exitCode}`}):\n${tail(first.output)}` }
  const a = outputDigest(root, cfg.output)
  const second = await command(cfg.command)
  if (!ran(second)) return { id: "G-DATA", status: "fail", kind: "gate", excerpt: `G-DATA: the pipeline failed when run again (${second.timedOut ? "timed out" : `exit ${second.exitCode}`}):\n${tail(second.output)}` }
  const b = outputDigest(root, cfg.output)
  if (!a || !b) return { id: "G-DATA", status: "fail", kind: "gate", excerpt: `G-DATA: the pipeline wrote nothing at ${cfg.output}` }
  if (a.sha !== b.sha) return { id: "G-DATA", status: "fail", kind: "gate", excerpt: `G-DATA: running the pipeline twice changed its output at ${cfg.output} (${a.lines} → ${b.lines} lines): it isn't idempotent. Upsert or merge on a key, and replace partitions atomically.` }
  return { id: "G-DATA", status: "pass", note: `two runs, identical output (${b.files} file(s), ${b.lines} lines)` }
}

// The evaluation itself: a work that changes it can't be judged by it
export const EVAL_FILES = /(^|\/)(evals?|evaluation|benchmarks?)\/|(^|\/)(eval|evaluate|evaluation)[\w-]*\.(py|js|mjs|ts|ipynb|ya?ml|json)$/

/** G-EVAL: the confirmed evaluation; its metric must not regress past the confirmed baseline */
export async function evalGate({ root, command, changed = [], now = Date.now }) {
  const cfg = gateCommands(root).eval
  if (!cfg) return nc("G-EVAL", "eval")
  const touched = changed.filter((rel) => EVAL_FILES.test(rel) && rel !== cfg.metrics)
  if (touched.length) return { id: "G-EVAL", status: "not_checked", reason: `this work changed the evaluation itself (${touched.slice(0, 3).join(", ")}), so it can't judge the work; a person reviews evaluation changes` }
  const started = now()
  const out = await command(cfg.command)
  if (!ran(out)) return { id: "G-EVAL", status: "fail", kind: "gate", excerpt: `G-EVAL: the evaluation failed (${out.timedOut ? "timed out" : `exit ${out.exitCode}`}):\n${tail(out.output)}` }
  const file = join(root, cfg.metrics)
  if (!existsSync(file) || statSync(file).mtimeMs < started - 1000) return { id: "G-EVAL", status: "fail", kind: "gate", excerpt: `G-EVAL: the evaluation didn't write ${cfg.metrics} in this run` }
  let value
  try {
    value = JSON.parse(readFileSync(file, "utf8"))?.[cfg.metric]
  } catch {
    // Reported below
  }
  if (!Number.isFinite(value)) return { id: "G-EVAL", status: "fail", kind: "gate", excerpt: `G-EVAL: ${cfg.metrics} has no number "${cfg.metric}"` }
  const baseline = readBaseline(root)
  if (!baseline || baseline.metric !== cfg.metric) {
    writeCandidate(root, { metric: cfg.metric, value, direction: cfg.direction, at: new Date().toISOString() })
    return { id: "G-EVAL", status: "not_checked", reason: `no confirmed baseline yet: ${cfg.metric} = ${value} recorded; kriya eval baseline confirm makes it the baseline` }
  }
  const worse = cfg.direction === "lower" ? value > baseline.value + cfg.margin : value < baseline.value - cfg.margin
  if (worse) return { id: "G-EVAL", status: "fail", kind: "gate", excerpt: `G-EVAL: ${cfg.metric} is ${value}, worse than the confirmed baseline ${baseline.value} (${cfg.direction} is better, margin ${cfg.margin}). A change ships only if it holds or beats the baseline.` }
  return { id: "G-EVAL", status: "pass", note: `${cfg.metric} ${value} vs baseline ${baseline.value}` }
}

const SANITIZER = /==\d+==ERROR: (AddressSanitizer|LeakSanitizer)|WARNING: ThreadSanitizer|runtime error: |ERROR: AddressSanitizer|SUMMARY: (Address|Thread|Undefined|Leak)Sanitizer/

/** G-SAN, G-IAC, G-SIM: the confirmed command exits 0 (G-SAN also fails on any sanitizer report) */
export async function commandGate({ root, command, gate, id }) {
  const cfg = gateCommands(root)[gate]
  if (!cfg) return nc(id, gate)
  const out = await command(cfg.command)
  if (id === "G-SAN" && SANITIZER.test(out.output ?? "")) return { id, status: "fail", kind: "gate", excerpt: `G-SAN: a sanitizer reported a problem:\n${tail(String(out.output).split("\n").filter((l) => SANITIZER.test(l) || /^\s+#\d+ /.test(l)).slice(0, 30).join("\n"))}` }
  if (!ran(out)) return { id, status: "fail", kind: "gate", excerpt: `${id}: \`${cfg.command}\` ${out.timedOut ? "timed out" : `exited ${out.exitCode}`}:\n${tail(out.output)}` }
  return { id, status: "pass" }
}

const HASH = /^STATE-HASH:\s*([0-9a-fA-F]{8,128})\s*$/m
const FRAME = /^FRAME-MS-MEDIAN:\s*([\d.]+)\s*$/m

/** G-SIM-HEADLESS: the seeded simulation twice; the same STATE-HASH both times; the median frame time within budget if one is set */
export async function simHeadlessGate({ root, command }) {
  const cfg = gateCommands(root)["sim-headless"]
  if (!cfg) return nc("G-SIM-HEADLESS", "sim-headless")
  const runs = [await command(cfg.command), await command(cfg.command)]
  const bad = runs.find((r) => !ran(r))
  if (bad) return { id: "G-SIM-HEADLESS", status: "fail", kind: "gate", excerpt: `G-SIM-HEADLESS: the simulation ${bad.timedOut ? "timed out" : `exited ${bad.exitCode}`}:\n${tail(bad.output)}` }
  const hashes = runs.map((r) => HASH.exec(r.output ?? "")?.[1])
  if (hashes.some((h) => !h)) return { id: "G-SIM-HEADLESS", status: "fail", kind: "gate", excerpt: "G-SIM-HEADLESS: the simulation must print STATE-HASH: <hex> of its final state" }
  if (hashes[0] !== hashes[1]) return { id: "G-SIM-HEADLESS", status: "fail", kind: "gate", excerpt: `G-SIM-HEADLESS: the same seed gave two different final states (${hashes[0]} vs ${hashes[1]}): the simulation isn't deterministic (wall clock, unseeded random, frame-rate-dependent steps)` }
  const frame = Number(FRAME.exec(runs[1].output ?? "")?.[1])
  if (cfg.frameBudgetMs && Number.isFinite(frame) && frame > cfg.frameBudgetMs) return { id: "G-SIM-HEADLESS", status: "fail", kind: "gate", excerpt: `G-SIM-HEADLESS: median frame time ${frame} ms is over the ${cfg.frameBudgetMs} ms budget` }
  return { id: "G-SIM-HEADLESS", status: "pass", note: `deterministic (${hashes[0].slice(0, 12)})${Number.isFinite(frame) ? `, median frame ${frame} ms` : ""}` }
}
