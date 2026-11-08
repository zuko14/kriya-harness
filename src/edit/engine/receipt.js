// Receipts, reports and `kriya edit verify` (EDIT_ENGINE §12, QUALITY_GATES §6, ED10).
// The receipt is proof of what was done: hashes of every input and of the output,
// tool versions, the plan's hash, every gate's numbers and the verdict, tokens and
// money as the gateway reported them. `verify` re-measures a file against it.

import { readFileSync, statSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

import { canonical, hashProject, sha256 } from "../core/project.js"
import { fileSha256 } from "../runtime/manifest.js"
import { measureLoudness } from "./loudness.js"
import { runTool } from "./tool.js"

export const RECEIPT_SCHEMA = 1
const FLICKS = 705_600_000

export const receiptPath = (file) => file.replace(/\.[^./]+$/, ".receipt.json")
export const reportPath = (file) => file.replace(/\.[^./]+$/, ".report.html")

/** The facts verify compares: what the file is, read from the file. */
export async function factsOf(file, run = runTool) {
  const data = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 120_000 }))
  const video = data.streams.find((s) => s.codec_type === "video")
  const audio = data.streams.find((s) => s.codec_type === "audio")
  const { integrated, truePeak } = audio ? await measureLoudness(file, { run }) : { integrated: null, truePeak: null }
  return {
    video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate, pixFmt: video.pix_fmt } : null,
    audio: audio ? { codec: audio.codec_name, rate: Number(audio.sample_rate), channels: audio.channels } : null,
    seconds: Math.round(Number(data.format.duration) * 1000) / 1000,
    loudness: { integrated: integrated === null ? null : Math.round(integrated * 10) / 10, truePeak: truePeak === null ? null : Math.round(truePeak * 10) / 10 },
  }
}

/**
 * @param {{ file: string, project: object, parent: string | null, plan: object, sources: Record<string, string>, tools: object, gates: object[], verdict: string, calls: object[], exportedAnyway?: boolean, run?: typeof runTool }} input
 *   sources: asset id → path; calls: the journal's Director calls for the job
 */
export async function makeReceipt({ file, project, parent, plan, sources, tools, gates, verdict, calls, exportedAnyway = false, run = runTool }) {
  const inputs = {}
  for (const [id, path] of Object.entries(sources)) inputs[id] = { sha256: await fileSha256(path), bytes: statSync(path).size }
  const tokens = calls.reduce((sum, c) => ({ input: sum.input + (c.input_tokens ?? 0), cached: sum.cached + (c.cached_tokens ?? 0), output: sum.output + (c.output_tokens ?? 0) }), { input: 0, cached: 0, output: 0 })
  return {
    schema: RECEIPT_SCHEMA,
    file: { name: basename(file), sha256: await fileSha256(file), bytes: statSync(file).size },
    facts: await factsOf(file, run),
    project: { hash: hashProject(project), parent },
    plan: { hash: sha256(canonical(plan)), quality: plan.quality, seconds: Math.round((plan.duration / FLICKS) * 1000) / 1000 },
    inputs,
    tools,
    gates: gates.map((g) => ({ id: g.id, status: g.status, severity: g.severity, numbers: g.numbers, ...(g.message ? { message: g.message } : {}) })),
    verdict,
    ...(exportedAnyway ? { exportedAnyway: true } : {}),
    // Money only as the gateway reports it: Kriya never prices a call itself
    model: { calls: calls.length, tokens, money: calls.some((c) => c.cost !== undefined && c.cost !== null) ? calls.reduce((sum, c) => sum + (c.cost ?? 0), 0) : "not reported by the gateway" },
  }
}

export function writeReceipt(file, receipt) {
  const path = receiptPath(file)
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return path
}

/**
 * Re-measures a file against its receipt (ET-QG-21). The same bytes match outright;
 * different bytes are re-measured and every difference is listed.
 * @returns {Promise<{ ok: boolean, identical: boolean, differences: string[] }>}
 */
export async function verifyFile(file, receipt, run = runTool) {
  if (receipt?.schema !== RECEIPT_SCHEMA) return { ok: false, identical: false, differences: ["this isn't a receipt this version can read"] }
  if ((await fileSha256(file)) === receipt.file.sha256) return { ok: true, identical: true, differences: [] }
  const now = await factsOf(file, run)
  const was = receipt.facts
  const differences = []
  for (const key of ["codec", "width", "height", "fps", "pixFmt"]) if (now.video?.[key] !== was.video?.[key]) differences.push(`video ${key}: ${was.video?.[key]} → ${now.video?.[key]}`)
  for (const key of ["codec", "rate", "channels"]) if (now.audio?.[key] !== was.audio?.[key]) differences.push(`audio ${key}: ${was.audio?.[key]} → ${now.audio?.[key]}`)
  if (Math.abs(now.seconds - was.seconds) > 0.034) differences.push(`length: ${was.seconds} s → ${now.seconds} s`)
  if (was.loudness.integrated !== null && (now.loudness.integrated === null || Math.abs(now.loudness.integrated - was.loudness.integrated) > 0.2)) differences.push(`loudness: ${was.loudness.integrated} → ${now.loudness.integrated} LUFS`)
  if (was.loudness.truePeak !== null && now.loudness.truePeak !== null && now.loudness.truePeak - was.loudness.truePeak > 0.3) differences.push(`true peak: ${was.loudness.truePeak} → ${now.loudness.truePeak} dBTP`)
  // Same measurements, other bytes: not the file the receipt describes
  return { ok: false, identical: false, differences: differences.length ? differences : ["the bytes differ from the receipt's, though it measures the same"] }
}

export const readReceipt = (path) => JSON.parse(readFileSync(path, "utf8"))

/* ─────────────────────────────── the report ─────────────────────────────── */

const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const WORDS = { delivered: "Checked", delivered_with_notes: "Checked, with notes", blocked: "Needs you", not_checked: "Not checked" }

/**
 * One page beside the export (QUALITY_GATES §6): verdict, facts, each gate with its
 * numbers, before and after contact sheets, the changes, notes, rights, tokens and money.
 * @param {{ receipt: object, title: string, before?: Buffer | null, after?: Buffer | null, changes: string[], notes: string[], rights: { id: string, rights: string, role: string }[], repairs?: object[] }} input jpgs as Buffers
 */
export function reportHtml({ receipt, title, before = null, after = null, changes, notes, rights, repairs = [] }) {
  const img = (jpg, alt) => (jpg ? `<img alt="${esc(alt)}" src="data:image/jpeg;base64,${jpg.toString("base64")}">` : `<p class="muted">No ${esc(alt)}.</p>`)
  const facts = receipt.facts
  const rows = receipt.gates.map((g) => `<tr><td>${esc(g.id)}</td><td class="s-${esc(g.status)}">${esc(g.status.replaceAll("_", " "))}${g.severity === "note" && g.status === "failed" ? " (note)" : ""}</td><td>${esc(g.message ?? "")}</td><td><code>${esc(JSON.stringify(g.numbers ?? {}))}</code></td></tr>`).join("")
  const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`)
  const money = typeof receipt.model.money === "number" ? `${receipt.model.money}` : receipt.model.money
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}: report</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1b18;--muted:#6b665e;--line:#e3ded5;--ok:#1f7a4d;--bad:#b3261e;--note:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece8e1;--muted:#a49e94;--line:#34312c;--ok:#5fcf97;--bad:#ff8a80;--note:#f2c46d}}
body{margin:0 auto;max-width:960px;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.muted{color:var(--muted)}
.verdict{font-size:18px;font-weight:600}.v-delivered{color:var(--ok)}.v-blocked{color:var(--bad)}.v-delivered_with_notes,.v-not_checked{color:var(--note)}
table{width:100%;border-collapse:collapse;font-size:13px}td{border-top:1px solid var(--line);padding:6px 8px;vertical-align:top}code{font-size:12px;word-break:break-all}
.s-passed{color:var(--ok)}.s-failed{color:var(--bad)}.s-not_checked,.s-not_applicable{color:var(--muted)}
.sheets{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sheets img{width:100%;border:1px solid var(--line)}@media (max-width:640px){.sheets{grid-template-columns:1fr}}
</style></head><body>
<h1>${esc(title)}</h1><p class="verdict v-${esc(receipt.verdict)}">${esc(WORDS[receipt.verdict] ?? receipt.verdict)}${receipt.exportedAnyway ? " (exported anyway)" : ""}</p>
<p class="muted">${esc(receipt.file.name)} · ${esc(facts.video ? `${facts.video.width}×${facts.video.height} ${facts.video.codec} ${facts.video.fps}` : "no picture")} · ${esc(facts.seconds)} s · ${esc(facts.loudness.integrated)} LUFS · ${esc(facts.loudness.truePeak)} dBTP · sha256 <code>${esc(receipt.file.sha256.slice(0, 16))}…</code></p>
<h2>Gates</h2><table>${rows}</table>
<h2>Before and after</h2><div class="sheets"><div><p class="muted">Source</p>${img(before, "source contact sheet")}</div><div><p class="muted">Delivered</p>${img(after, "delivered contact sheet")}</div></div>
<h2>What changed</h2>${list(changes)}
${repairs.length ? `<h2>Repairs</h2>${list(repairs.map((r) => `Round ${r.round}: ${r.fixes.map((f) => f.why).join(" ")} ${r.accepted ? "Kept." : `Set aside${r.reason ? `: ${r.reason}` : ", it wasn't better"}.`}`))}` : ""}
<h2>Notes</h2>${list(notes)}
<h2>Rights</h2>${list(rights.map((r) => `${r.id} (${r.role}): ${r.rights}`))}
<h2>Model use</h2><p>${esc(receipt.model.calls)} calls · ${esc(receipt.model.tokens.input)} input tokens (${esc(receipt.model.tokens.cached)} cached) · ${esc(receipt.model.tokens.output)} output tokens · money: ${esc(money)}</p>
</body></html>
`
}
