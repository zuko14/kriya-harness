// QG-08…QG-11 on one custom tile, before the person sees it (MG2, TP9; DIRECTOR_AND_AGENT §11 step 4).
// The tile is rendered in the runtime's Chrome inside the OS sandbox, exactly as the film will draw it,
// and judged by the gates' own measures: where its words land (QG-08), whether they read on their own
// plate (QG-09: the footage behind is unknown here, so a word must carry its own plate or outline),
// what an OCR reads back (QG-10, where the helper exists) and whether it moves at all (QG-11). The
// film's own gates run again on the rendered cut; this is the check before a proposal is offered.

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { confinement } from "../engine/confine.js"
import { customDocument, measureText, renderTile, tileSeconds } from "../engine/motion.js"
import { runTool } from "../engine/tool.js"
import { judgeCopy, ocrHelper, readOcr } from "./copy.js"
import { THRESHOLDS } from "./index.js"
import { judgeMotion, tileFrames } from "./picture.js"
import { contrast, luminance, parseColour, strokeContrast } from "./text.js"

const FLICKS = 705_600_000
const round = (n) => Math.round(n * 100) / 100

/** QG-08 and QG-09 from measured boxes (pure, so the rules are tested without Chrome). @param {object[][]} sets boxes per time */
export function judgeTileText(sets, { output, safe, thresholds = THRESHOLDS }) {
  const { width, height } = output
  const layout = []
  const legibility = []
  for (const boxes of sets) {
    for (const [i, box] of boxes.entries()) {
      if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > width + 0.5 || box.y + box.h > height + 0.5) layout.push({ kind: "outside_frame", text: box.text })
      else if (box.y < safe.top - 0.5 || box.x < safe.left - 0.5 || box.x + box.w > width - safe.right + 0.5 || box.y + box.h > height - safe.bottom + 0.5) layout.push({ kind: "outside_safe_zone", text: box.text })
      if (box.clipped) layout.push({ kind: "clipped", text: box.text })
      for (const other of boxes.slice(i + 1)) if (box.x < other.x + other.w && other.x < box.x + box.w && box.y < other.y + other.h && other.y < box.y + box.h) layout.push({ kind: "overlap", text: box.text })
    }
  }
  // Legibility at rest (the first set): text against its own plate, or its own outline
  for (const box of sets[0] ?? []) {
    const plate = parseColour(box.plate)
    const texts = (box.colours ?? []).map(parseColour).filter(Boolean)
    const onPlate = plate && plate.alpha >= 0.9 && texts.length ? Math.min(...texts.map((t) => contrast(luminance(t.rgb), luminance(plate.rgb)))) : null
    const value = Math.max(onPlate ?? 0, strokeContrast(box) ?? 0)
    if (!value) legibility.push({ kind: "no_plate", text: box.text })
    else if (value < thresholds.contrast) legibility.push({ kind: "low_contrast", text: box.text, contrast: round(value), needed: thresholds.contrast })
    if (box.size / height < thresholds.minTextShare) legibility.push({ kind: "too_small", text: box.text, px: box.size, minimum: Math.ceil(thresholds.minTextShare * height) })
  }
  const status = (failures, any) => (!any ? "not_applicable" : failures.length ? "failed" : "passed")
  const any = sets.some((boxes) => boxes.length)
  return [
    { id: "QG-08", status: status(layout, any), failures: layout },
    { id: "QG-09", status: status(legibility, any), failures: legibility },
  ]
}

/**
 * @param {{ node: object, output: { width: number, height: number, fps: object }, canvas: object, safe: object, runtime: object, work: string, run?: Function, which?: object, binDir?: string, launch?: Function, ocr?: boolean }} input
 *   safe: the safe zone in output pixels; binDir: where the OCR helper is built (QG-10 is not checked without it)
 * @returns {Promise<{ passed: boolean, results: { id: string, status: string, failures?: object[] }[] }>}
 */
export async function gateCustomTile({ node, output, canvas, safe, runtime, work, run = runTool, which = confinement(), binDir, launch, thresholds = THRESHOLDS }) {
  const html = customDocument(node, { output, canvas }, { allowed: true, which })
  mkdirSync(work, { recursive: true })
  const file = join(work, "tile.mov")
  const seconds = tileSeconds(node.duration, output.fps)
  try {
    await renderTile({ html, work: join(work, "render"), output: file, fps: output.fps, runtime, run, which, seconds, launch })
    const results = []
    // QG-11: it moves, and every frame of its window is there
    const frames = await tileFrames(file, run)
    const expected = Math.ceil((node.duration * output.fps.n) / (FLICKS * output.fps.d) - 1e-9)
    const motion = judgeMotion([{ tile: { at: 0 }, frames, expected }], thresholds)
    results.push({ id: "QG-11", status: motion.failures.length ? "failed" : "passed", failures: motion.failures })
    // QG-08, QG-09: the words' boxes at rest and on the last frame
    const frameMs = (1000 * output.fps.d) / output.fps.n
    const last = Math.max(0, (node.duration / FLICKS) * 1000 - frameMs)
    const times = [...new Set([Math.min(last, 950), Math.round(last)])]
    const measured = await measureText({ items: [{ id: "t", html, times }], work: join(work, "measure"), runtime, which, launch })
    results.push(...judgeTileText(measured.get("t") ?? [], { output, safe, thresholds }))
    // QG-10: what a reader sees at rest, over mid grey, against the words meant
    const texts = node.variables.texts ?? []
    if (!texts.length) results.push({ id: "QG-10", status: "not_applicable" })
    else {
      const helper = binDir ? await ocrHelper(binDir, run) : { missing: "no helper folder" }
      if (helper.missing) results.push({ id: "QG-10", status: "not_checked", message: helper.missing })
      else {
        const dir = join(work, "ocr")
        mkdirSync(dir, { recursive: true })
        await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", (Math.min(last, 1000) / 1000).toFixed(3), "-i", file, "-f", "lavfi", "-i", `color=c=0x808080:s=${output.width}x${output.height}`, "-filter_complex", "[0:v]setpts=PTS-STARTPTS[tile];[1:v][tile]overlay=shortest=1", "-frames:v", "1", "-y", join(dir, "t0000.png")], { timeoutMs: 60_000 })
        const seen = readOcr(await run(helper.path, [dir], { timeoutMs: 120_000 })).get("t0000.png")
        const judged = judgeCopy([{ tile: { kind: "block", node, at: 0 }, seen: seen?.text ?? "", unsure: seen?.unsure ?? [] }], thresholds)
        results.push({ id: "QG-10", status: judged.failures.length ? "failed" : judged.unread?.length ? "not_checked" : "passed", failures: judged.failures })
      }
    }
    return { passed: results.every((r) => r.status !== "failed"), results }
  } finally {
    rmSync(join(work, "render"), { recursive: true, force: true })
  }
}
