// What a delivered export carries (ED10): its receipt and its report beside it, and
// the speech recogniser the gates may trust. A recogniser counts as verified only
// when the signed manifest ships its weights as an artifact (EB-11), never because a
// folder with the right name exists.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

import { thumbArgs } from "../core/ffmpeg.js"
import { handoffManifest, timelineMarkers, toEdl, toFcpxml, toOtio, toSrt } from "../core/handoff.js"
import { solve } from "../core/solver.js"
import { EngineFailure } from "../engine/tool.js"
import { chapterList } from "../index/story.js"
import { makeReceipt, reportHtml, reportPath, writeReceipt } from "../engine/receipt.js"
import { childEnv } from "../runtime/setup.js"
import { MODEL, readWords, recogniser, speechArgs, transcribeArgs } from "../index/layers/words.js"

/** (file) → words heard, or undefined when this runtime has no verified recogniser. */
export function verifiedRecogniser(runtime, { run, work, language = "en", platform = `${process.platform}-${process.arch}` }) {
  const shipped = runtime?.manifest?.platforms?.[platform]?.artifacts?.some((a) => a.id === MODEL)
  if (!shipped) return undefined
  const engine = recogniser(runtime, platform)
  if (engine.missing) return undefined
  return async (file) => {
    mkdirSync(work, { recursive: true })
    const dir = mkdtempSync(join(work, "heard-"))
    try {
      const audio = join(dir, "speech.wav")
      await run("ffmpeg", speechArgs(file, audio), { timeoutMs: 600_000 })
      const env = { ...childEnv(), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" }
      return readWords(await run(engine.python, transcribeArgs(engine, audio, language), { env, timeoutMs: 1_800_000 }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A contact sheet of a file, as JPEG bytes; null if it can't be made. */
async function sheetOf(file, seconds, { run, work }) {
  const out = join(work, `sheet-${Math.random().toString(36).slice(2)}.jpg`)
  try {
    await run("ffmpeg", thumbArgs({ source: file, output: out, every: Math.max(1, Math.ceil(seconds / 20)), columns: 5, rows: 4 }), { timeoutMs: 300_000 })
    return readFileSync(out)
  } catch {
    return null
  } finally {
    rmSync(out, { force: true })
  }
}

/**
 * Writes `<name>.receipt.json` and `<name>.report.html` beside the export.
 * @returns {Promise<{ receipt: string, report: string, verdict: string }>}
 */
export async function writeDelivery({ file, title, project, parent, plan, sourcePath, tools, gates, verdict, calls, changes, notes, repairs = [], beforeFrom, run, work }) {
  mkdirSync(work, { recursive: true })
  const used = new Set([...plan.segments.flatMap((s) => [...s.node.picture, ...s.node.overlays].map((i) => i.asset)), ...plan.audio.items.map((i) => i.asset)])
  const sources = Object.fromEntries([...used].map((id) => [id, sourcePath(id)]))
  const receipt = await makeReceipt({ file, project, parent, plan, sources, tools, gates, verdict, calls, run })
  const receiptFile = writeReceipt(file, receipt)
  const seconds = plan.duration / 705_600_000
  const before = beforeFrom ? await sheetOf(beforeFrom, seconds * 2, { run, work }) : null
  const after = await sheetOf(file, seconds, { run, work })
  const rights = project.assets.filter((a) => used.has(a.id)).map((a) => ({ id: a.id, rights: a.rights, role: a.role }))
  const report = reportPath(file)
  writeFileSync(report, reportHtml({ receipt, title, before, after, changes, notes, rights, repairs }))
  return { receipt: receiptFile, report, verdict: receipt.verdict }
}

/**
 * A handoff package (EDIT_ENGINE §11): the current cut as OTIO, FCPXML, CMX 3600 EDL and
 * SRT in a new folder under the exports folder, chapters as markers, the media linked in
 * at the relative paths those files name, and a manifest of what to relink and what a
 * format couldn't carry. Sources are linked, never copied or written.
 * shortcut: media are symbolic links to the person's files, so a package moved to another computer relinks from the manifest; copying is not built
 * @returns {{ folder: string, files: string[], media: number, omitted: object[], chapters: { name: string, at: number }[] }}
 */
export function writeHandoff({ project, index, exportsDir, sourcePath }) {
  const timeline = solve(project, index)
  if (!timeline.picture.length) throw new EngineFailure("input", "empty", "There is nothing on the timeline to hand off yet.")
  const { markers, lost } = timelineMarkers(project, index, timeline)
  const slug = project.name.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "edit"
  mkdirSync(exportsDir, { recursive: true })
  let folder
  for (let n = 1; ; n++) {
    folder = join(exportsDir, `${slug}-handoff${n === 1 ? "" : `-${n}`}`)
    try {
      mkdirSync(folder)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
  const fcpxml = toFcpxml(project, timeline, markers)
  const edl = toEdl(project, timeline)
  const files = { [`${slug}.otio`]: toOtio(project, timeline, markers), [`${slug}.fcpxml`]: fcpxml.text, [`${slug}.edl`]: edl.text }
  if (timeline.captions.length) files[`${slug}.srt`] = toSrt(timeline)
  if (markers.length) files["chapters.txt"] = `${chapterList(markers.map((m) => ({ at: m.at, title: m.name })))}\n`
  const omitted = [
    ...fcpxml.omitted.map((o) => ({ format: "fcpxml", ...o })),
    ...edl.omitted.map((o) => ({ format: "edl", ...o })),
    ...lost.map((o) => ({ format: "all", ...o })),
    ...(timeline.captions.length ? [] : [{ format: "srt", reason: "this cut has no captions, so there is no SRT" }]),
  ]
  const media = handoffManifest(project, timeline)
  for (const entry of media) {
    const target = resolve(folder, entry.path)
    if (!target.startsWith(folder + sep)) {
      omitted.push({ format: "all", asset: entry.asset, reason: "its path would leave the package, so it isn't linked; relink it by hand" })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(sourcePath(entry.asset), target)
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, { flag: "wx" })
  const manifest = { kriya: "handoff", version: 1, name: project.name, fps: timeline.fps, duration: timeline.duration, files: Object.keys(files), media, chapters: markers, omitted }
  writeFileSync(join(folder, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
  return { folder, files: [...Object.keys(files), "manifest.json"], media: media.length, omitted, chapters: markers }
}
