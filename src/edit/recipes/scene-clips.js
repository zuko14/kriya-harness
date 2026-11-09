// Scene clips (VISUAL_SCENES.md §3.2): an approved plan's scenes as operations on the cut as
// solved. The words anchor them, so a scene moves with its speech; each label is timed to the
// word it's said on; code checks again what the plan checked, since a re-cut can drop a line.

import { arrangeScenes, MAX_SHARE, revealWords } from "../director/beats.js"
import { cleanScene, SCENE_BLOCK, SCENE_THEMES, SCENE_VERSION } from "../engine/scenes.js"
import { solve } from "../core/solver.js"

const FLICKS = 705_600_000
const OPENING = 2 * FLICKS // the speaker is seen first
// Removing pauses can tighten an approved gap: closer than this, the first scene holds until the next starts, so the speaker doesn't flash between them
const MIN_GAP = 1 * FLICKS
const MIN_LENGTH = 2 * FLICKS
const MAX_LENGTH = 15 * FLICKS
const REVEAL_GAP = 0.6 * FLICKS // pops closer than this blur together

/**
 * pictures: approved licensed clips, resolved to assets; terms: quoted definitions to show on their words.
 * @param {{ scenes: object[], pictures?: { asset: string, from: string, to: string }[], terms?: { at: string, term: string, quote: string, source: string }[], project: object, index: object, asset: string, kept: { id: string }[], captions?: boolean, sound?: { scene?: string, reveal?: string } }} input
 *   project: with the cut applied; kept: the words the cut keeps
 * @returns {{ ops: object[], covered: Set<string>, notes: string[] }} covered: the words under a scene
 */
export function sceneOps({ scenes, pictures = [], terms = [], project, index, asset, kept, captions = false, sound = {} }) {
  const notes = []
  const covered = new Set()
  const ops = []
  const { scenes: arranged, dropped } = arrangeScenes(scenes, { index, asset })
  for (const { scene, reason } of dropped) notes.push(`Left out the ${scene.kind} scene: ${reason}.`)
  const timeline = solve(project, index)
  const story = timeline.picture.filter((p) => !p.echo && !p.hold)
  const start = story[0]?.at ?? 0
  const outputOf = (word, edge) => {
    const t = edge === "start" ? word.start : word.end
    const piece = story.find((p) => p.asset === asset && t >= p.in && t <= p.out)
    return piece ? piece.at + (t - piece.in) : null
  }
  const keptIds = new Set(kept.map((w) => w.id))
  const words = index.words.filter((w) => w.asset === asset)
  const byId = new Map(words.map((w) => [w.id, w]))
  let last = -Infinity
  let previous = null
  let used = 0
  for (const raw of arranged) {
    const scene = cleanScene(raw)
    const from = byId.get(scene.from)
    const to = byId.get(scene.to)
    const name = `"${scene.title || scene.items[0].text}"`
    const spoken = words.filter((w) => w.start >= from.start && w.end <= to.end && keptIds.has(w.id))
    if (!spoken.length) {
      notes.push(`Left out the scene ${name}: its lines aren't in this cut.`)
      continue
    }
    const at = outputOf(spoken[0], "start")
    const end = outputOf(spoken.at(-1), "end")
    const length = end - at
    const refuse = at === null || end === null || !(length > 0) ? "its lines aren't together in this cut" : at < start + OPENING ? "the speaker is seen first" : length < MIN_LENGTH ? "its lines are too short in this cut" : length > MAX_LENGTH ? "its lines are apart in this cut" : at < last ? "its lines come before the last scene in this cut" : used + length > timeline.duration * MAX_SHARE ? "the speaker would hardly be seen" : null
    if (refuse) {
      notes.push(`Left out the scene ${name}: ${refuse}.`)
      continue
    }
    if (previous && at - last < MIN_GAP) previous.until = { word: spoken[0].id, edge: "start" }
    const landing = revealWords(scene, spoken)
    const items = scene.items.map((item, i) => {
      const t = landing[i] && outputOf(landing[i], "start")
      return { ...item, ...(t === null || t === undefined ? {} : { reveal: Math.round(((t - at) / FLICKS) * 1000) }) }
    })
    last = end
    used += length
    for (const word of spoken) covered.add(word.id)
    previous = {
      op: "add_motion",
      block: SCENE_BLOCK,
      version: SCENE_VERSION,
      variables: { kind: scene.kind, theme: scene.theme, title: scene.title, text: scene.title || scene.items[0].text, items, ...(scene.mode ? { mode: scene.mode } : {}), ...(captions && SCENE_THEMES[scene.theme].band ? { band: true } : {}) },
      at: { word: spoken[0].id, edge: "start" },
      until: { word: spoken.at(-1).id, edge: "end" },
    }
    ops.push(previous)
    if (sound.scene) ops.push({ op: "add_sfx", asset: sound.scene, peak_at: { word: spoken[0].id, edge: "start" } })
    if (sound.reveal) {
      let lastPop = at
      for (const word of landing) {
        const t = word && outputOf(word, "start")
        if (t === null || t === undefined || t - lastPop < REVEAL_GAP) continue
        lastPop = t
        ops.push({ op: "add_sfx", asset: sound.reveal, peak_at: { word: word.id, edge: "start" } })
      }
    }
  }
  const taken = ops.filter((o) => o.op === "add_motion").map((o) => ({ at: outputOf(byId.get(o.at.word), "start"), end: outputOf(byId.get(o.until.word), "end") }))
  for (const picture of pictures) {
    const from = byId.get(picture.from)
    const to = byId.get(picture.to)
    const asset_ = project.assets.find((a) => a.id === picture.asset)
    const spoken = from && to ? words.filter((w) => w.start >= from.start && w.end <= to.end && keptIds.has(w.id)) : []
    if (!spoken.length || !asset_) {
      notes.push("Left out a picture: its lines aren't in this cut.")
      continue
    }
    const at = outputOf(spoken[0], "start")
    const end = outputOf(spoken.at(-1), "end")
    const length = end - at
    const refuse = at === null || end === null || !(length > 0) ? "its lines aren't together in this cut" : at < start + OPENING ? "the speaker is seen first" : length < MIN_LENGTH || length > MAX_LENGTH ? "its lines don't fit it in this cut" : taken.some((t) => at < t.end && t.at < end) ? "a scene is already there" : length > (asset_.facts.duration ?? 0) ? "the clip is too short for its lines" : used + length > timeline.duration * MAX_SHARE ? "the speaker would hardly be seen" : null
    if (refuse) {
      notes.push(`Left out a picture: ${refuse}.`)
      continue
    }
    used += length
    taken.push({ at, end })
    for (const word of spoken) covered.add(word.id)
    ops.push({ op: "place_broll", asset: asset_.id, at: { word: spoken[0].id, edge: "start" }, until: { word: spoken.at(-1).id, edge: "end" } })
    if (sound.scene) ops.push({ op: "add_sfx", asset: sound.scene, peak_at: { word: spoken[0].id, edge: "start" } })
  }
  for (const term of terms) {
    const word = byId.get(term.at)
    const at = word && keptIds.has(word.id) ? outputOf(word, "start") : null
    if (at === null || taken.some((t) => at >= t.at && at < t.end)) {
      notes.push(`Left out the definition of "${term.term}": something else is on screen there, or the line isn't in this cut.`)
      continue
    }
    // Long enough to read: letters over 15 a second, plus a second and a half
    const seconds = Math.min(7, (term.term.length + term.quote.length + term.source.length) / 15 + 1.5)
    const duration = Math.round(Math.min(seconds * FLICKS, Math.max(FLICKS, timeline.duration - at)))
    ops.push({ op: "add_motion", block: "term", version: 1, variables: { text: term.term, quote: term.quote, source: term.source, ...(term.page ? { page: term.page } : {}) }, at: { word: word.id, edge: "start" }, duration })
  }
  return { ops, covered, notes }
}
