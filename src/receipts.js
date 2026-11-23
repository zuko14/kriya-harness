import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { stepLabel } from "./loop.js"
import { canonical } from "./mcp.js"
import { CLIENT_VERSION, kriyaHome } from "./paths.js"
import { redact } from "../plugins/repo/repo.js"
import { readState } from "./release.js"
import { progressFiles, readProgress, verdict } from "./verify.js"

// Harness 2.0 W19, proof receipts (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// DIFFERENTIATORS.md D1, WD-24). What Kriya Harness checked by code on this
// computer, copied from the session's ledger (progress file): verdicts,
// attempts, roles, tiers, gate results, cartridge versions. Nothing from model
// text, and no file contents, prompts, commands, output or paths. A hash chain
// over the ledger's run records makes any later edit of one visible: `kriya
// receipt verify` recomputes it and names the first link that fails. It is
// evidence of what was checked, labelled so, never a guarantee.

export const LABEL = "checked on this computer"
const SEED = "kriya-receipt-1"
const sha = (text) => createHash("sha256").update(text).digest("hex")
const CARTRIDGE = /^(kriya-role-[a-z]{2,20})@(\d{1,3}\.\d{1,3}\.\d{1,3})$/
const ID = /^[A-Za-z0-9_.-]{1,60}$/

export class ReceiptError extends Error {}

/** h_0 = sha256(seed); h_i = sha256(h_{i-1} ‖ canonical(run_i)). */
export function chainLinks(runs) {
  const links = []
  let h = sha(SEED)
  for (const run of runs ?? []) links.push((h = sha(h + canonical(run))))
  return links
}

/** The receipt for a ledger, by code only. `meta`: { project, session, commit, client }. */
export function receiptFrom(progress, meta) {
  const runs = progress.runs ?? []
  const plan = progress.plan
  const v = verdict(progress)
  const cartridges = {}
  for (const b of progress.builders ?? []) {
    const m = CARTRIDGE.exec(b.cartridge ?? "")
    if (m) cartridges[m[1]] = m[2]
  }
  const steps = (plan?.steps ?? []).map((step, i) => {
    const label = stepLabel(plan, i + 1)
    const found = v.steps.find((s) => s.step === label)
    const last = runs.findLast((r) => r.step === label)
    return {
      n: i + 1,
      ...(typeof step.role === "string" && ID.test(step.role) && { role: step.role }),
      verdict: found?.status ?? "not run",
      attempts: found?.attempts ?? 0,
      tiers: (progress.builders ?? []).filter((b) => b.step === label && typeof b.tier === "string" && ID.test(b.tier)).map((b) => b.tier),
      gates: (last?.gates ?? []).filter((g) => /^G-[A-Z0-9-]{2,20}$/.test(g?.id ?? "")).map((g) => ({ id: g.id, status: String(g.status) })),
    }
  })
  const links = chainLinks(runs)
  return {
    receipt: 1,
    label: LABEL,
    project: meta.project,
    session: meta.session,
    ...(meta.commit && { commit: meta.commit }),
    ...(runs.at(-1)?.tree && { tree: runs.at(-1).tree }),
    client: meta.client,
    verdict: v.status,
    ...(Object.keys(cartridges).length && { cartridges }),
    steps,
    runs: runs.length,
    chain: `sha256:${links.at(-1) ?? sha(SEED)}`,
    links,
  }
}

/** The readable receipt: what was checked, how to verify it, and what it isn't. */
export function receiptMarkdown(r) {
  const lines = [
    `## Proof receipt (${LABEL})`,
    "",
    "What Kriya Harness checked by code on this computer, copied from its own records. Evidence of what was checked, not a guarantee.",
    "",
    `- Verdict: **${r.verdict}**, ${r.runs} check run${r.runs === 1 ? "" : "s"}`,
    ...(r.commit ? [`- Commit: \`${r.commit.slice(0, 12)}\``] : []),
    ...(r.cartridges ? [`- Cartridges: ${Object.entries(r.cartridges).map(([id, v]) => `${id}@${v}`).join(", ")}`] : []),
    `- Kriya Harness ${r.client}`,
  ]
  if (r.steps.length) {
    lines.push("", "| Step | Role | Verdict | Attempts | Tiers | Gates |", "| --- | --- | --- | --- | --- | --- |")
    for (const s of r.steps) lines.push(`| ${s.n} | ${s.role ?? "—"} | ${s.verdict} | ${s.attempts} | ${s.tiers.join(", ") || "—"} | ${s.gates.map((g) => `${g.id} ${g.status}`).join(", ") || "—"} |`)
  }
  lines.push("", `Chain: \`${r.chain}\` (verify with \`kriya receipt verify\`).`)
  return lines.join("\n")
}

const projectKey = (root) => sha(root).slice(0, 16)
const headOf = (root) => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

export const receiptFiles = (project, session) => {
  const dir = join(kriyaHome(), "receipts", project)
  return { json: join(dir, `${session}.json`), md: join(dir, `${session}.md`) }
}

/** Builds and writes a session's receipt; returns it with its readable form. */
export function makeReceipt(root, sessionId) {
  progressFiles(root, sessionId)
  const progress = readProgress(root, sessionId)
  if (!progress.runs?.length && !progress.plan) throw new ReceiptError("That session has no plan and no check runs to put in a receipt.")
  const commit = headOf(root)
  const receipt = receiptFrom(progress, { project: projectKey(root), session: sessionId, ...(/^[0-9a-f]{40}$/.test(commit ?? "") && { commit }), client: CLIENT_VERSION })
  // WD-22: what Kriya refused to run is written down for the person (readable part only: the verified fields stay the ledger's)
  const left = readState(root).forPerson ?? []
  const markdown = [
    receiptMarkdown(receipt),
    ...(left.length
      ? ["", "### For you to run (Kriya never runs these)", "", ...left.map((p) => `- \`${redact(p.command).replace(/`/g, "'").replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")}\`: it ${p.why}`)]
      : []),
  ].join("\n")
  const files = receiptFiles(receipt.project, sessionId)
  mkdirSync(dirname(files.json), { recursive: true })
  for (const [file, text] of [[files.json, `${JSON.stringify(receipt, null, 2)}\n`], [files.md, `${markdown}\n`]]) {
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  return { receipt, markdown, files }
}

/** The project's most recent session with a ledger, for `kriya receipt make` without an id. */
export function latestSession(root) {
  const dir = dirname(progressFiles(root, "x").json)
  let best
  for (const f of (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()) {
    if (!f.endsWith(".json") || f === "milestones.json") continue
    const at = statSync(join(dir, f)).mtimeMs
    if (!best || at > best.at) best = { id: f.slice(0, -5), at }
  }
  return best?.id
}

/**
 * Recomputes a receipt from the ledger it names: the chain link by link
 * (the first changed, missing or extra run is named), then every field.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyReceipt(text) {
  let r
  try {
    r = JSON.parse(text)
  } catch {
    return { ok: false, problems: ["The receipt isn't JSON."] }
  }
  if (r?.receipt !== 1 || !/^[0-9a-f]{16}$/.test(r.project ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(r.session ?? "")) return { ok: false, problems: ["That isn't a Kriya receipt."] }
  let progress
  try {
    progress = JSON.parse(readFileSync(join(kriyaHome(), "progress", r.project, `${r.session}.json`), "utf8"))
  } catch {
    return { ok: false, problems: ["The session's records aren't on this computer, so the receipt can't be checked here."] }
  }
  const problems = []
  const now = chainLinks(progress.runs ?? [])
  const was = Array.isArray(r.links) ? r.links : []
  const n = Math.max(now.length, was.length)
  for (let i = 0; i < n; i++) {
    if (now[i] === was[i]) continue
    problems.push(i >= now.length ? `Run ${i + 1} is in the receipt but no longer in the records.` : i >= was.length ? `Run ${i + 1} was added to the records after the receipt.` : `Run ${i + 1} (step ${progress.runs[i]?.step ?? "?"}) was changed after the receipt: the chain breaks at link ${i + 1}.`)
    break
  }
  if (r.chain !== `sha256:${was.at(-1) ?? sha(SEED)}`) problems.push("The receipt's chain doesn't match its own links.")
  const again = receiptFrom(progress, { project: r.project, session: r.session, ...(r.commit && { commit: r.commit }), client: r.client })
  for (const key of new Set([...Object.keys(again), ...Object.keys(r)]))
    if (key !== "links" && canonical(again[key]) !== canonical(r[key])) problems.push(`"${key}" doesn't match the records.`)
  return { ok: problems.length === 0, problems }
}

/* ─────────────── Harness 2.0 W17: kriya report ─────────────── */

/**
 * `kriya report`: a bundle the person attaches to a bug report themselves.
 * Versions, the gates' capability matrix and self-tests, and this project's
 * receipts (already free of file contents, prompts, commands, output, paths
 * and secrets) with their chains, plus the release records' ids and statuses.
 * Commands left for the person are kept with secrets redacted and query
 * strings removed. Nothing is sent anywhere.
 */
export async function makeReport(root, { gates, now = () => new Date() } = {}) {
  const { gateMatrix, gateSelfTests } = await import("./doctor.js")
  const { readState } = await import("./release.js")
  const project = projectKey(root)
  const receipts = []
  for (const f of (() => {
    try {
      return readdirSync(join(kriyaHome(), "progress", project))
    } catch {
      return []
    }
  })()) {
    if (!f.endsWith(".json") || f === "milestones.json") continue
    const session = f.slice(0, -5)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) continue
    try {
      receipts.push(receiptFrom(readProgress(root, session), { project, session, client: CLIENT_VERSION }))
    } catch {
      // A record that isn't a session's
    }
  }
  const state = readState(root)
  const report = {
    report: 1,
    at: now().toISOString(),
    client: CLIENT_VERSION,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    project,
    gates: gates ?? { matrix: await gateMatrix(), selfTests: await gateSelfTests() },
    receipts,
    releases: state.records.map((r) => ({ kind: r.kind, ...(r.target && { target: r.target }), commit: r.commit, ...(r.ready !== undefined && { ready: r.ready }), ...(r.ok !== undefined && { ok: r.ok }), ...(r.lines && { lines: r.lines }) })),
    forPerson: (state.forPerson ?? []).map((p) => ({ why: p.why, command: redact(p.command).replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1") })),
  }
  const file = join(kriyaHome(), "reports", `report-${report.at.replace(/[:.]/g, "-")}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { report, file }
}
