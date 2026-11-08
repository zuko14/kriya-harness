// Handoff (EDIT_ENGINE §11): editors can always leave with their work. Paths are
// relative; what a format can't carry is listed, never silently dropped.

import { clockTime, flicksToFrames, FLICKS, fractionSeconds, frameFlicks, timecode } from "./time.js"

const OTIO_BASE = { effects: [], markers: [], enabled: true, metadata: {} }

const baseName = (path) => path.split(/[\\/]/).at(-1)
const assetOf = (project, id) => project.assets.find((a) => a.id === id)
const isAbsolute = (path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)

/** Relative path of an asset inside the handoff package; two files of one name get their asset id in front. */
function mediaPath(project, { id, path }) {
  if (!isAbsolute(path)) return path
  const name = baseName(path)
  const shared = project.assets.some((a) => a.id !== id && isAbsolute(a.path) && baseName(a.path) === name)
  return shared ? `media/${id}-${name}` : `media/${name}`
}

const sourced = (timeline) => [...timeline.picture, ...timeline.overlays.filter((o) => o.asset), ...timeline.audio]

/** What to relink: each asset the timeline uses, once. */
export function handoffManifest(project, timeline) {
  return [...new Set(sourced(timeline).map((item) => item.asset))].map((id) => {
    const asset = assetOf(project, id)
    return { asset: id, path: mediaPath(project, asset), fingerprint: asset.fingerprint, ...(asset.sha256 ? { sha256: asset.sha256 } : {}) }
  })
}

// Exact: frames at the canvas rate when it fits, otherwise flicks as OTIO's own rate
function rationalTime(t, fps) {
  const frame = frameFlicks(fps)
  const fits = frame === null ? false : t % frame === 0
  return { OTIO_SCHEMA: "RationalTime.1", rate: fits ? fps.n / fps.d : FLICKS, value: fits ? t / frame : t }
}

const timeRange = (start, duration, fps) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rationalTime(start, fps), duration: rationalTime(duration, fps) })

function otioEffects(item) {
  const common = { name: "", metadata: {} }
  if (item.hold) return [{ OTIO_SCHEMA: "FreezeFrame.1", ...common, effect_name: "FreezeFrame", time_scalar: 0 }]
  if (item.speed && item.speed.n !== item.speed.d) return [{ OTIO_SCHEMA: "LinearTimeWarp.1", ...common, effect_name: "LinearTimeWarp", time_scalar: item.speed.n / item.speed.d }]
  return []
}

function otioTrack(project, name, kind, items, fps) {
  const children = []
  let cursor = 0
  for (const item of items) {
    if (item.at > cursor) children.push({ OTIO_SCHEMA: "Gap.1", name: "", source_range: timeRange(0, item.at - cursor, fps), ...OTIO_BASE })
    const asset = assetOf(project, item.asset)
    children.push({
      OTIO_SCHEMA: "Clip.2",
      name: item.clip,
      source_range: timeRange(item.in, item.end - item.at, fps),
      media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", name: baseName(asset.path), target_url: mediaPath(project, asset), available_range: null, available_image_bounds: null, metadata: {} } },
      active_media_reference_key: "DEFAULT_MEDIA",
      ...OTIO_BASE,
      effects: otioEffects(item),
    })
    cursor = item.end
  }
  return { OTIO_SCHEMA: "Track.1", name, kind, source_range: null, children, ...OTIO_BASE }
}

// A track can't hold overlaps, so overlapping items go to further tracks of that role
function lanes(items) {
  const result = []
  for (const item of [...items].sort((a, b) => a.at - b.at)) {
    const lane = result.find((list) => list.at(-1).end <= item.at)
    if (lane) lane.push(item)
    else result.push([item])
  }
  return result
}

/**
 * The sequence's markers on the timeline, from a time or a word; one whose word was cut is listed as lost.
 * @returns {{ markers: { name: string, at: number }[], lost: { clip: string, reason: string }[] }}
 */
export function timelineMarkers(project, index, timeline) {
  const words = new Map((index?.words ?? []).map((w) => [w.id, w]))
  const markers = []
  const lost = []
  for (const marker of project.sequences.find((q) => q.id === project.active).markers) {
    let at = typeof marker.at === "number" ? marker.at : null
    const word = words.get(marker.at.word)
    if (word) {
      const t = marker.at.edge === "end" ? word.end : word.start
      const piece = timeline.picture.find((p) => !p.hold && p.asset === word.asset && p.in <= t && t < p.out)
      if (piece) at = piece.at + Math.round(((t - piece.in) * piece.speed.d) / piece.speed.n)
    }
    if (at === null || at < 0 || at >= timeline.duration) lost.push({ clip: marker.id, reason: `marker "${marker.name}" isn't on the timeline any more` })
    else markers.push({ name: marker.name, at: snapTo(at, timeline.fps) })
  }
  return { markers: markers.sort((a, b) => a.at - b.at), lost }
}

// The frame a time falls on, as flicks: FCPXML and NLEs place edits on frames
function snapTo(t, fps) {
  const frame = frameFlicks(fps)
  return frame === null ? t : Math.round(t / frame) * frame
}

/** @param {{ name: string, at: number }[]} [markers] chapters, as markers on the whole timeline */
export function toOtio(project, timeline, markers = []) {
  const { fps } = timeline
  const group = (items, name, kind) => lanes(items).map((lane, i) => otioTrack(project, i === 0 ? name : `${name} ${i + 1}`, kind, lane, fps))
  const footage = timeline.overlays.filter((o) => o.asset)
  const roles = [...new Set(footage.map((o) => o.role))]
  const sounds = [...new Set(timeline.audio.map((a) => a.role))]
  const children = [
    ...group(timeline.picture, "base", "Video"),
    ...roles.flatMap((role) => group(footage.filter((o) => o.role === role), role, "Video")),
    ...sounds.flatMap((role) => group(timeline.audio.filter((a) => a.role === role), role, "Audio")),
  ]
  const marks = markers.map((m) => ({ OTIO_SCHEMA: "Marker.2", name: m.name, marked_range: timeRange(m.at, 0, fps), color: "RED", comment: "", metadata: {} }))
  const stack = { OTIO_SCHEMA: "Stack.1", name: "tracks", source_range: null, children, ...OTIO_BASE, markers: marks }
  return `${JSON.stringify({ OTIO_SCHEMA: "Timeline.1", name: project.name, global_start_time: null, metadata: {}, tracks: stack }, null, 2)}\n`
}

const xml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")

function timeNotes(timeline, format) {
  const notes = new Map()
  for (const piece of timeline.picture) {
    if (piece.hold) notes.set(`${piece.clip}:hold`, { clip: piece.clip, reason: `${format} here carries no freeze frame; hold it by hand` })
    else if (piece.speed.n !== piece.speed.d) notes.set(`${piece.clip}:speed`, { clip: piece.clip, reason: `${format} here carries no speed change; set ${piece.speed.n}/${piece.speed.d} by hand` })
  }
  return [...notes.values()]
}

/**
 * @param {{ name: string, at: number }[]} [markers] chapters, written as chapter markers in the clip under each
 * @returns {{ text: string, omitted: { clip: string, reason: string }[] }}
 */
export function toFcpxml(project, timeline, markers = []) {
  const { width, height, fps } = project.canvas
  const used = handoffManifest(project, timeline)
  const ref = new Map(used.map(({ asset }, i) => [asset, `r${i + 2}`]))
  const resources = used.map(({ asset: id, path }) => {
    const asset = assetOf(project, id)
    const video = asset.kind === "video" || asset.kind === "image"
    const audio = asset.facts.hasAudio !== false && asset.kind !== "image"
    const media = `<media-rep kind="original-media" src="${xml(encodeURI(path))}"/>`
    return `    <asset id="${ref.get(id)}" name="${xml(baseName(asset.path))}" start="0s" duration="${fractionSeconds(asset.facts.duration ?? 0)}"${video ? ' hasVideo="1" format="r1"' : ""}${audio ? ' hasAudio="1"' : ""}>${media}</asset>`
  })
  // Connected sound is placed on the sample; Final Cut takes edits on frames, so it moves to the nearest
  const frame = (t) => snapTo(t, fps)
  const connected = (item, lane, parent) => `<asset-clip ref="${ref.get(item.asset)}" lane="${lane}" offset="${fractionSeconds(frame(parent.in + item.at - parent.at))}" start="${fractionSeconds(frame(item.in))}" duration="${fractionSeconds(Math.max(frame(item.end - item.at), frameFlicks(fps) ?? 1))}" name="${xml(item.clip)}"/>`
  const extras = [...timeline.overlays.filter((o) => o.asset).map((item) => [item, 1]), ...timeline.audio.filter((a) => a.role !== "dialogue").map((item) => [item, -1])]
  const spine = timeline.picture.map((piece) => {
    const chapters = markers
      .filter((m) => m.at >= piece.at && m.at < piece.end)
      .map((m) => `          <chapter-marker start="${fractionSeconds(piece.in + Math.round(((m.at - piece.at) * piece.speed.n) / piece.speed.d))}" duration="${fps.d}/${fps.n}s" value="${xml(m.name)}" posterOffset="0s"/>`)
    const inner = [...extras.filter(([item]) => item.at >= piece.at && item.at < piece.end).map(([item, lane]) => `          ${connected(item, lane, piece)}`), ...chapters]
    const open = `<asset-clip ref="${ref.get(piece.asset)}" offset="${fractionSeconds(piece.at)}" start="${fractionSeconds(piece.in)}" duration="${fractionSeconds(piece.end - piece.at)}" name="${xml(piece.clip)}"`
    return inner.length ? `        ${open}>\n${inner.join("\n")}\n        </asset-clip>` : `        ${open}/>`
  })
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.10">',
    "  <resources>",
    `    <format id="r1" frameDuration="${fps.d}/${fps.n}s" width="${width}" height="${height}"/>`,
    ...resources,
    "  </resources>",
    "  <library>",
    `    <event name="${xml(project.name)}">`,
    `      <project name="${xml(project.name)}">`,
    `      <sequence format="r1" duration="${fractionSeconds(timeline.duration)}" tcStart="0s" tcFormat="NDF">`,
    "      <spine>",
    ...spine,
    "      </spine>",
    "      </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  ].join("\n")
  return { text, omitted: [...timeNotes(timeline, "FCPXML"), ...timeline.overlays.filter((o) => !o.asset).map((o) => ({ clip: o.clip, reason: "motion and titles travel as overlay clips, not FCPXML titles" }))] }
}

// CMX 3600 record times start at the conventional 01:00:00:00
const reel = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "AX"
const edlTitle = (name) => name.replace(/[\r\n]+/g, " ").slice(0, 70)

/** @returns {{ text: string, omitted: { clip: string, reason: string }[] }} */
export function toEdl(project, timeline) {
  const { fps } = timeline
  const start = 3600 * Math.ceil(fps.n / fps.d)
  const lines = [`TITLE: ${edlTitle(project.name)}`, "FCM: NON-DROP FRAME", ""]
  timeline.picture.forEach((piece, i) => {
    const frames = flicksToFrames(piece.end, fps) - flicksToFrames(piece.at, fps)
    const source = flicksToFrames(piece.in, fps)
    const record = start + flicksToFrames(piece.at, fps)
    lines.push(`${String(i + 1).padStart(3, "0")}  ${reel(piece.asset).padEnd(8)} AA/V  C        ${timecode(source, fps)} ${timecode(source + frames, fps)} ${timecode(record, fps)} ${timecode(record + frames, fps)}`)
    lines.push(`* FROM CLIP NAME: ${baseName(assetOf(project, piece.asset).path)}`)
  })
  const extras = [...timeline.overlays, ...timeline.audio.filter((a) => a.role !== "dialogue")]
  return { text: `${lines.join("\n")}\n`, omitted: [...timeNotes(timeline, "EDL"), ...extras.map((item) => ({ clip: item.clip, reason: `an EDL holds simple cuts, so this ${item.role} clip isn't in it` }))] }
}

const ordered = (timeline) => [...timeline.captions].sort((a, b) => a.at - b.at)
// A blank line would end the cue early
const cueText = (text) => text.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim()

export function toSrt(timeline) {
  return ordered(timeline)
    .map((caption, i) => `${i + 1}\n${clockTime(caption.at, ",")} --> ${clockTime(caption.end, ",")}\n${cueText(caption.text)}\n`)
    .join("\n")
}

export function toVtt(timeline) {
  const safe = (text) => cueText(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `WEBVTT\n\n${ordered(timeline)
    .map((caption) => `${clockTime(caption.at, ".")} --> ${clockTime(caption.end, ".")}\n${safe(caption.text)}\n`)
    .join("\n")}`
}
